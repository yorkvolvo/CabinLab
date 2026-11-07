import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CabinRuntime,
  initialVehicle,
  previewVehicle,
  replayEvidence,
} from '../src/domain/runtime';
import { compileDemo } from '../src/domain/compiler';
import { inspectEvidence } from '../src/domain/evidence';
import { resourceOf, type TemplateId } from '../src/domain/scenario';
import { cloneTemplate, templates } from '../src/domain/templates';

for (const id of Object.keys(templates) as TemplateId[]) {
  const scenario = cloneTemplate(id);
  const initial = previewVehicle(scenario);
  const capability = scenario.actions[0].capability;
  const finish = (runtime: CabinRuntime) => {
    if (id === 'passengerWait') {
      runtime.setSignals({ driverDoorOpen: true });
      runtime.setSignals({ driverOccupied: false });
      runtime.setSignals({ driverDoorOpen: false });
    }
    if (id === 'petWait') runtime.setSignals({ petPresent: true });
    const snapshot = runtime.step(90);
    if (snapshot.reminderDueAt !== undefined) return runtime.advanceTo(snapshot.reminderDueAt);
    if (scenario.reminder?.kind === 'charge')
      return runtime.setSignals({ batteryPercent: scenario.reminder.atPercent });
    return snapshot;
  };
  test(`${id} 请求被拒绝，不得记为接受或达成，导出结果可独立复核`, () => {
    const result = finish(new CabinRuntime(scenario, initial, `${capability}:rejected`));
    const status = id === 'petWait' ? 'waiting' : 'partial';
    assert.equal(result.status, status);
    assert.equal(result.events.filter((event) => event.kind === 'rejected').length, 1);
    assert.equal(
      result.events.some(
        (event) =>
          event.capability === capability && ['accepted', 'confirmed'].includes(event.kind),
      ),
      false,
    );
    assert.equal(inspectEvidence(JSON.stringify(result)).replayed.status, status);
  });
  test(`${id} 回读丢失保留最后已知状态，不再控制同一设备`, () => {
    const runtime = new CabinRuntime(scenario, initial, `${capability}:feedback-lost`);
    const result = finish(runtime);
    const status = id === 'petWait' ? 'waiting' : 'uncertain';
    assert.equal(result.status, status);
    const unknown = result.events.filter((event) => event.kind === 'unknown');
    const accepted = result.events.filter(
      (event) => event.kind === 'accepted' && event.capability === capability,
    );
    assert.equal(unknown.length, 1);
    assert.equal(accepted.length, 1);
    assert.equal(unknown[0].time - accepted[0].time, scenario.timeoutSeconds);
    assert.deepEqual(unknown[0].state, accepted[0].state);
    assert.equal(
      result.events.some(
        (event) =>
          event.kind === 'confirmed' && resourceOf(event.capability!) === resourceOf(capability),
      ),
      false,
    );
    assert.equal(inspectEvidence(JSON.stringify(result)).replayed.status, status);
    const next = runtime.step(90);
    if (id === 'petWait') assert.deepEqual(next.events, result.events);
    else assert.deepEqual(next, result);
  });
}

test('雨天联动中窗路受阻或空调开启失败时，独立设备仍然完成', () => {
  const scenario = cloneTemplate('rainLink');
  const initial = previewVehicle(scenario);
  const blocked = new CabinRuntime(scenario, { ...initial, windowPathClear: false }).step(20);
  assert.equal(blocked.status, 'partial');
  assert.equal(blocked.vehicle.windowsClosed, false);
  assert.equal(blocked.vehicle.frontDefrost, true);
  assert.equal(blocked.vehicle.mirrorHeat, true);
  const rejected = new CabinRuntime(scenario, initial, 'climate.power:rejected').step(20);
  assert.equal(rejected.status, 'partial');
  assert.equal(rejected.vehicle.windowsClosed, true);
  assert.equal(rejected.vehicle.frontDefrost, false);
  assert.equal(rejected.vehicle.mirrorHeat, true);
});

test('关窗前或在途无法确认窗路安全时，不产生全闭回读且结果可重放', () => {
  const scenario = cloneTemplate('rainClose');
  const initial = previewVehicle(scenario);
  const blocked = new CabinRuntime(scenario, { ...initial, windowPathClear: undefined }).step(20);
  assert.ok(blocked.events.some((event) => event.kind === 'blocked'));
  assert.ok(!blocked.events.some((event) => event.kind === 'accepted'));
  const pending = new CabinRuntime(scenario, initial);
  assert.equal(pending.step(5).pending, 'window.close');
  pending.setSignals({ windowPathClear: false });
  const result = pending.step(20);
  assert.equal(result.status, 'partial');
  assert.equal(result.vehicle.windowsClosed, false);
  assert.equal(inspectEvidence(JSON.stringify(result)).replayed.vehicle.windowsClosed, false);
});

test('前挡除雾要求空调成功开启，旧运行时不会接受新能力或信号', () => {
  const scenario = cloneTemplate('rainDefog');
  const initial = previewVehicle(scenario);
  const run = new CabinRuntime(scenario, initial, 'climate.power:rejected').step(20);
  assert.equal(run.vehicle.frontDefrost, false);
  assert.ok(
    run.events.some(
      (event) => event.kind === 'blocked' && event.capability === 'climate.frontDefrost',
    ),
  );
  assert.throws(() => new CabinRuntime(scenario, initial, 'none', 'old', '1.2.0'), /旧运行时/);
  const nap = { ...cloneTemplate('nap'), exit: 'cancel-pending-no-restore' as const };
  const old = new CabinRuntime(nap, previewVehicle(nap), 'none', 'old', '1.2.0');
  assert.throws(() => old.setSignals({ rainLevel: 3 }), /旧运行时/);
  const waiting = old.step(6);
  assert.equal(inspectEvidence(JSON.stringify(waiting)).replayed.reminderDueAt, 1206);
});

test('媒体播放回读丢失后，后续音量控制也停止，已达成的空调不回滚', () => {
  const result = new CabinRuntime(
    cloneTemplate('rest'),
    initialVehicle,
    'media.play:feedback-lost',
  ).step(90);
  assert.equal(result.vehicle.targetTemperature, 24);
  assert.equal(result.vehicle.volume, 30);
  assert.equal(result.status, 'uncertain');
  assert.equal(
    result.events.some((event) => event.kind === 'blocked' && event.capability === 'media.volume'),
    true,
  );
});

test('在回读丢失截止前重放，继续推进仍得到相同的未知结果', () => {
  const runtime = new CabinRuntime(
    cloneTemplate('rest'),
    initialVehicle,
    'climate.power:feedback-lost',
  );
  const pending = runtime.step(11);
  assert.equal(pending.pending, 'climate.power');
  assert.equal(inspectEvidence(JSON.stringify(pending)).replayed.status, 'executing');
  const replay = replayEvidence(pending);
  assert.deepEqual(replay.step(90).events, runtime.step(90).events);
});

test('回读丢失的在途请求可停止，后续推进不会迟到达成，新运行不继承故障', () => {
  const runtime = new CabinRuntime(
    cloneTemplate('rest'),
    initialVehicle,
    'climate.power:feedback-lost',
  );
  runtime.step(10);
  runtime.cancel();
  const result = runtime.step(90);
  assert.equal(result.status, 'cancelled');
  assert.equal(
    result.events.some((event) => ['unknown', 'confirmed'].includes(event.kind)),
    false,
  );
  assert.equal(inspectEvidence(JSON.stringify(result)).replayed.status, 'cancelled');
  assert.equal(new CabinRuntime(cloneTemplate('rest')).step(90).status, 'completed');
});

test('原 1.0.0 运行时的冻结证据仍能复核，不改写版本与事件', () => {
  const fixture = readFileSync(new URL('./fixtures/runtime-1.0.json', import.meta.url), 'utf8');
  const { source, replayed } = inspectEvidence(fixture);
  assert.equal(source.runtimeVersion, '1.0.0');
  assert.equal(replayed.runtimeVersion, '1.0.0');
  assert.deepEqual(source.events, replayed.events);
  assert.deepEqual(source.commands, replayed.commands);
});

test('旧版本不能携带新故障，未知故障在运行入口即拒绝', () => {
  assert.throws(() => new CabinRuntime(cloneTemplate('rest'), initialVehicle, 'invalid' as never));
  assert.throws(
    () =>
      new CabinRuntime(
        cloneTemplate('rest'),
        initialVehicle,
        'climate.power:rejected',
        'old',
        '1.0.0',
      ),
  );
  const run = new CabinRuntime(
    cloneTemplate('rest'),
    initialVehicle,
    'climate.power:rejected',
  ).step(90);
  assert.throws(() => inspectEvidence(JSON.stringify({ ...run, runtimeVersion: '1.0.0' })), /重放/);
});

test('篡改未知结果为成功、失败或普通超时都无法复核', () => {
  const source = new CabinRuntime(
    cloneTemplate('rest'),
    initialVehicle,
    'media.play:feedback-lost',
  ).step(90);
  for (const status of ['completed', 'partial'])
    assert.throws(() => inspectEvidence(JSON.stringify({ ...source, status })), /不一致/);
  const changed = structuredClone(source);
  changed.events.find((event) => event.kind === 'unknown')!.kind = 'timeout';
  assert.throws(() => inspectEvidence(JSON.stringify(changed)), /不一致/);
});

for (const prompt of [
  '停车休息时不要开空调',
  '停车看书，别打开阅读灯',
  '取消停车休息场景',
  '停车不播放音乐',
  '车内不太热时就打开空调',
  '停止空调场景',
  '停车休息，不要恢复空调，但退出时恢复音乐',
  '车内三十度就开空调',
  '停车休息持续二十秒后开空调',
  '停车休息把风量设为两档',
])
  test(`本地创建不能忽略否定、取消或中文数值：${prompt}`, () => {
    assert.throws(() => compileDemo(prompt));
  });

test('明确结束条件与不恢复策略仍可使用，三个完整示例均能生成待确认草案', () => {
  for (const template of Object.values(templates)) {
    const result = compileDemo(template.sourcePrompt);
    assert.equal(result.draft.templateId, template.templateId);
    assert.equal(result.draft.confirmed, false);
  }
  assert.equal(compileDemo('停车休息，不要恢复设备状态').draft.exit, 'cancel-pending-no-restore');
});
