import assert from 'node:assert/strict';
import { mkdir, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { compile, configFromEnv } from '../server/provider';
import {
  actionLabel,
  catalog,
  reminderLabel,
  signalLabels,
  type Scenario,
} from '../src/domain/scenario';
import { templates } from '../src/domain/templates';
import { CompileError } from '../src/domain/compiler';
import { parseMessagesStream } from '../server/messages';
import { CabinRuntime, previewVehicle } from '../src/domain/runtime';
import { inspectEvidence } from '../src/domain/evidence';

const config = configFromEnv({
  ...process.env,
  LLM_SECONDARY_MODEL: undefined,
  OPENAI_API_KEY: undefined,
});
assert.notEqual(config.provider, 'demo', '真实模型验收必须显式配置模型服务');
const rounds = Number(process.argv[2] ?? 3);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0, '轮数必须为正整数');
const models = process.argv.slice(3).length ? process.argv.slice(3) : [config.model!];
const families = process.env.VERIFY_TEMPLATES?.split(',');
const baselines = Object.values(templates).filter(
  (template) => !families || families.includes(template.templateId),
);
assert.ok(
  baselines.length && (!families || baselines.length === families.length),
  'VERIFY_TEMPLATES 包含未知或重复的场景族',
);
await mkdir('.local', { recursive: true });
const report = `.local/model-stability-${new Date().toISOString().replaceAll(':', '-')}.ndjson`;
const records: {
  model: string;
  passed: boolean;
  elapsedMs: number;
  requests: number;
  error?: string;
}[] = [];

batch: for (const model of models) {
  for (let round = 1; round <= rounds; round++) {
    for (const baseline of baselines) {
      let base: Scenario = structuredClone(baseline);
      for (const intent of ['create', 'modify'] as const) {
        const numeric = base.actions.find((action) => typeof action.value === 'number');
        const changed =
          numeric &&
          Math.min(
            Number(numeric.value) + 1,
            numeric.capability === 'climate.fan'
              ? 5
              : numeric.capability === 'climate.temperature'
                ? 30
                : numeric.capability === 'ambient.light'
                  ? 100
                  : numeric.capability === 'seat.recline'
                    ? 45
                    : 60,
          );
        const expected = structuredClone(intent === 'create' ? baseline : base);
        if (intent === 'modify') {
          if (expected.reminder?.kind === 'wake') expected.reminder.afterSeconds += 60;
          else if (expected.reminder?.kind === 'charge') expected.reminder.atPercent += 5;
          else if (expected.reminder?.kind === 'pet') expected.reminder.maxTemperature += 1;
          else if (expected.templateId === 'pickup') expected.trigger.threshold += 20;
          else expected.trigger.holdSeconds += 2;
          if (numeric && changed !== undefined)
            expected.actions.find((action) => action.capability === numeric.capability)!.value =
              changed;
          if (['rainClose', 'rainMirror', 'rainLink'].includes(expected.templateId))
            expected.trigger.threshold = 2;
        }
        const prompt =
          intent === 'create'
            ? baseline.reminder ||
              [
                'rainDefog',
                'pickup',
                'passengerWait',
                'rainClose',
                'rainMirror',
                'rainLink',
              ].includes(baseline.templateId)
              ? baseline.sourcePrompt
              : `创建“${baseline.name}”。仅 P 挡且车速为 0，${signalLabels[baseline.trigger.signal].label}${baseline.trigger.operator === 'gt' ? '高于' : '低于'} ${baseline.trigger.threshold}${signalLabels[baseline.trigger.signal].unit}连续 ${baseline.trigger.holdSeconds} 秒，依次执行：${baseline.actions.map(actionLabel).join('；')}。开始行驶或触发条件失效时停止后续动作，不恢复旧值。`
            : `只修改这两项：${expected.reminder?.kind === 'pet' ? `高温提醒阈值改为 ${expected.reminder.maxTemperature}°C` : expected.reminder ? reminderLabel(expected.reminder) : expected.templateId === 'pickup' ? `触发阈值改为 ${expected.trigger.threshold} 米` : `持续时间改为 ${expected.trigger.holdSeconds} 秒`}；${numeric ? `${catalog[numeric.capability].label}改为 ${changed}${catalog[numeric.capability].unit}` : '模拟雨量等级的触发阈值改为 2 级，仍须高于阈值'}。其余字段、动作及顺序全部原样保留，不增删动作。`;
        const started = performance.now();
        let passed = false;
        let error: string | undefined;
        let detail: string | undefined;
        let headersMs: number | undefined;
        let status: number | undefined;
        let requests = 0;
        let preview:
          | {
              status: string;
              reminderTime?: number;
              seatGuard?: boolean;
              confirmedActions?: number;
            }
          | undefined;
        let captured: Promise<string> | undefined;
        let contentType = '';
        try {
          const result = await compile(
            {
              prompt,
              templateId: baseline.templateId,
              intent,
              ...(intent === 'modify' ? { baseScenario: { ...base, confirmed: true } } : {}),
            },
            { ...config, model },
            async (url, init) => {
              requests++;
              const response = await fetch(url, init);
              headersMs = Math.round(performance.now() - started);
              status = response.status;
              contentType = response.headers.get('content-type') ?? '';
              captured = response
                .clone()
                .text()
                .catch(() => '');
              return response;
            },
          );
          assert.equal(result.mode, 'model');
          assert.equal(result.draft.confirmed, false);
          assert.equal(result.draft.templateId, baseline.templateId);
          if (intent === 'create') {
            assert.equal(result.draft.exit, baseline.exit);
            assert.deepEqual(result.draft.trigger, baseline.trigger);
            assert.deepEqual(result.draft.actions, baseline.actions);
            assert.deepEqual(result.draft.reminder, baseline.reminder);
            base = result.draft;
          } else {
            assert.deepEqual(
              {
                ...result.draft,
                sourcePrompt: base.sourcePrompt,
                version: base.version,
                confirmed: base.confirmed,
              },
              expected,
            );
          }
          preview = verifyPreview(result.draft, expected);
          passed = true;
        } catch (failure) {
          error =
            failure instanceof CompileError
              ? failure.code
              : failure instanceof Error
                ? failure.name
                : 'unknown';
          if (
            failure instanceof assert.AssertionError ||
            (failure instanceof CompileError && failure.code === 'needs_clarification')
          )
            detail = failure.message.slice(0, 4000);
          if (failure instanceof CompileError && failure.code === 'provider_output' && captured) {
            try {
              const raw = await captured;
              const envelope = contentType.includes('text/event-stream')
                ? parseMessagesStream(raw)
                : JSON.parse(raw);
              const output = envelope.content
                ?.filter((block: { type: string }) => block.type === 'text')
                .map((block: { text?: string }) => block.text ?? '')
                .join('');
              detail = JSON.stringify({ stopReason: envelope.stop_reason, output }).slice(0, 8000);
            } catch {
              detail = 'Upstream envelope invalid or incomplete';
            }
          }
        }
        if (detail && config.apiKey) detail = detail.replaceAll(config.apiKey, '[REDACTED]');
        const row = {
          model,
          round,
          template: baseline.templateId,
          intent,
          passed,
          elapsedMs: Math.round(performance.now() - started),
          headersMs,
          status,
          requests,
          preview,
          error,
          detail,
        };
        records.push(row);
        await appendFile(report, JSON.stringify(row) + '\n', { mode: 0o600 });
        console.log(JSON.stringify(row));
        if ([401, 403, 429, 503].includes(status ?? 0)) {
          console.log(JSON.stringify({ stopped: true, status, report }));
          break batch;
        }
        await delay(1000);
      }
    }
  }
}
for (const model of models) {
  const rows = records.filter((row) => row.model === model);
  const times = rows
    .filter((row) => row.passed)
    .map((row) => row.elapsedMs)
    .sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      model,
      passed: rows.filter((row) => row.passed).length,
      total: rows.length,
      requests: rows.reduce((sum, row) => sum + row.requests, 0),
      repaired: rows.filter((row) => row.passed && row.requests > 1).length,
      timeouts: rows.filter((row) => row.error === 'provider_timeout').length,
      p50Ms: times[Math.ceil(times.length * 0.5) - 1],
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      report,
    }),
  );
}
if (records.some((row) => !row.passed)) process.exitCode = 1;

function verifyPreview(draft: Scenario, expected: Scenario) {
  const scene = { ...draft, confirmed: true };
  const initial = previewVehicle(expected);
  const reminder = expected.reminder;
  const readyAt = expected.trigger.holdSeconds + expected.actions.length;
  const runtime = new CabinRuntime(scene, initial);
  if (!reminder) {
    const { signal, threshold, holdSeconds } = expected.trigger;
    if (signal === 'driverExit') {
      assert.equal(runtime.setSignals({ driverDoorOpen: true }).status, 'armed');
      assert.equal(runtime.setSignals({ driverOccupied: false }).status, 'armed');
      assert.equal(runtime.setSignals({ driverDoorOpen: false }).status, 'armed');
    } else {
      const boundary = new CabinRuntime(scene, { ...initial, [signal]: threshold });
      assert.equal(boundary.step(holdSeconds + 1).status, 'armed');
    }
    const complete = runtime.advanceTo(readyAt);
    assert.equal(complete.status, 'completed');
    assert.deepEqual(
      complete.events
        .filter((event) => event.kind === 'confirmed')
        .map(({ time, capability }) => ({ time, capability })),
      expected.actions.map(({ capability }, index) => ({
        time: holdSeconds + index + 1,
        capability,
      })),
    );
    if (expected.templateId === 'rainDefog') {
      assert.equal(complete.vehicle.frontDefrost, true);
      assert.equal(
        complete.vehicle.fan,
        expected.actions.find((action) => action.capability === 'climate.fan')?.value,
      );
    }
    if (expected.templateId === 'pickup' || expected.templateId === 'passengerWait') {
      assert.equal(
        complete.vehicle.targetTemperature,
        expected.actions.find((action) => action.capability === 'climate.temperature')?.value,
      );
      assert.equal(complete.vehicle.playing, false);
    }
    if (expected.templateId === 'rainClose') {
      assert.equal(complete.vehicle.windowsClosed, true);
      assert.deepEqual(
        complete.events.filter((event) => event.kind === 'reminder').map((event) => event.detail),
        ['雨天关窗：四门车窗已关闭'],
      );
      const blocked = new CabinRuntime(scene, { ...initial, windowPathClear: false }).advanceTo(
        readyAt,
      );
      assert.equal(blocked.vehicle.windowsClosed, false);
      assert.ok(!blocked.events.some((event) => event.kind === 'accepted'));
      assert.match(
        blocked.events.find((event) => event.kind === 'reminder')?.detail ?? '',
        /窗路有障碍或状态未知/,
      );
    }
    if (expected.templateId === 'rainMirror') assert.equal(complete.vehicle.mirrorHeat, true);
    if (expected.templateId === 'rainLink') {
      assert.equal(complete.events.filter((event) => event.kind === 'reminder').length, 1);
      assert.ok(
        complete.vehicle.windowsClosed &&
          complete.vehicle.frontDefrost &&
          complete.vehicle.mirrorHeat,
      );
      const blocked = new CabinRuntime(scene, { ...initial, windowPathClear: false }).advanceTo(
        readyAt,
      );
      assert.equal(blocked.status, 'partial');
      assert.equal(blocked.vehicle.windowsClosed, false);
      assert.ok(blocked.vehicle.frontDefrost && blocked.vehicle.mirrorHeat);
      assert.match(
        blocked.events.find((event) => event.kind === 'reminder')?.detail ?? '',
        /窗路有障碍或状态未知/,
      );
    }
    assert.equal(inspectEvidence(JSON.stringify(complete)).replayed.status, 'completed');
    return { status: complete.status, confirmedActions: expected.actions.length };
  }
  if (reminder.kind === 'pet') {
    assert.equal(runtime.step().status, 'armed');
    runtime.setSignals({ petPresent: true });
    const ready = runtime.advanceTo(readyAt + 1);
    assert.equal(ready.status, 'waiting');
    assert.equal(
      ready.vehicle.targetTemperature,
      expected.actions.find((a) => a.capability === 'climate.temperature')?.value,
    );
    assert.ok(
      !runtime
        .setSignals({ temperature: reminder.maxTemperature - 1 })
        .events.some((e) => e.kind === 'reminder'),
    );
    const high = runtime.setSignals({ temperature: reminder.maxTemperature });
    const countReminders = (snapshot: typeof high) =>
      snapshot.events.filter((e) => e.kind === 'reminder').length;
    assert.equal(high.status, 'waiting');
    assert.equal(countReminders(high), 1);
    assert.equal(countReminders(runtime.step(10)), 1);
    const low = runtime.setSignals({ batteryPercent: reminder.minBatteryPercent });
    assert.equal(countReminders(low), 2);
    assert.equal(
      low.events.filter((e) => e.kind === 'reminder').at(-1)?.detail,
      `宠物留舱提醒：电量降至 ${reminder.minBatteryPercent}%`,
    );
    assert.equal(inspectEvidence(JSON.stringify(low)).replayed.status, 'waiting');
    return {
      status: low.status,
      reminderTime: high.time,
      confirmedActions: expected.actions.length,
    };
  }
  const seat = expected.actions.find((action) => action.capability === 'seat.recline');
  assert.ok(seat);
  const ready = runtime.advanceTo(readyAt);
  assert.equal(ready.status, 'waiting');
  assert.equal(
    ready.vehicle[seat.seat === 'driver' ? 'driverRecline' : 'passengerRecline'],
    seat.value,
  );
  const before =
    reminder.kind === 'wake'
      ? runtime.advanceTo(readyAt + reminder.afterSeconds - 1)
      : runtime.setSignals({ batteryPercent: reminder.atPercent - 1 });
  assert.ok(!before.events.some((event) => event.kind === 'reminder'));
  const complete =
    reminder.kind === 'wake'
      ? runtime.step()
      : runtime.setSignals({ batteryPercent: reminder.atPercent });
  assert.equal(complete.status, 'completed');
  assert.equal(complete.events.filter((event) => event.kind === 'reminder').length, 1);
  if (expected.exit === 'cancel-pending-restore-settings') {
    const { gear, speed, batteryPercent, ...settings } = initial;
    const {
      gear: endGear,
      speed: endSpeed,
      batteryPercent: endBattery,
      ...endSettings
    } = complete.vehicle;
    assert.equal(endGear, gear);
    assert.equal(endSpeed, speed);
    assert.equal(endBattery, reminder.kind === 'charge' ? reminder.atPercent : batteryPercent);
    assert.deepEqual(endSettings, settings);
    assert.ok(
      complete.events.some(
        (event) => event.kind === 'restored' && event.capability === 'seat.recline',
      ),
    );
  }
  assert.equal(inspectEvidence(JSON.stringify(complete)).replayed.status, 'completed');
  const empty = new CabinRuntime(scene, {
    ...initial,
    driverOccupied: seat.seat !== 'driver',
    passengerOccupied: seat.seat !== 'passenger',
  }).advanceTo(readyAt);
  assert.ok(
    !empty.events.some((event) => event.kind === 'accepted' && event.capability === 'seat.recline'),
  );
  return { status: complete.status, reminderTime: complete.time, seatGuard: true };
}
