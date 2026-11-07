import assert from 'node:assert/strict';
import { mkdir, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { compile, configFromEnv } from '../server/provider';
import { actionLabel, catalog, signalLabels, type Scenario } from '../src/domain/scenario';
import { templates } from '../src/domain/templates';
import { CompileError } from '../src/domain/compiler';
import { parseMessagesStream } from '../server/messages';

const config = configFromEnv(process.env);
assert.notEqual(config.provider, 'demo', '真实模型验收必须显式配置模型服务');
const rounds = Number(process.argv[2] ?? 3);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0, '轮数必须为正整数');
const models = process.argv.slice(3).length ? process.argv.slice(3) : [config.model!];
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
    for (const baseline of Object.values(templates)) {
      let base: Scenario = structuredClone(baseline);
      for (const intent of ['create', 'modify'] as const) {
        const numeric = base.actions.find((action) => typeof action.value === 'number')!;
        const changed = Math.min(
          Number(numeric.value) + 1,
          numeric.capability === 'climate.fan'
            ? 5
            : numeric.capability === 'climate.temperature'
              ? 30
              : numeric.capability === 'ambient.light'
                ? 100
                : 60,
        );
        const prompt =
          intent === 'create'
            ? `创建“${baseline.name}”。仅 P 挡且车速为 0，${signalLabels[baseline.trigger.signal].label}${baseline.trigger.operator === 'gt' ? '高于' : '低于'} ${baseline.trigger.threshold}${signalLabels[baseline.trigger.signal].unit}连续 ${baseline.trigger.holdSeconds} 秒，依次执行：${baseline.actions.map(actionLabel).join('；')}。开始行驶或触发条件失效时停止后续动作，不恢复旧值。`
            : `只将持续时间改为 ${base.trigger.holdSeconds + 2} 秒，${catalog[numeric.capability].label}改为 ${changed}${catalog[numeric.capability].unit}。其余字段、动作及顺序全部原样保留，不增删动作。`;
        const started = performance.now();
        let passed = false;
        let error: string | undefined;
        let detail: string | undefined;
        let headersMs: number | undefined;
        let status: number | undefined;
        let requests = 0;
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
            assert.deepEqual(result.draft.trigger, baseline.trigger);
            assert.deepEqual(result.draft.actions, baseline.actions);
            base = result.draft;
          } else {
            const expected = structuredClone(base);
            expected.trigger.holdSeconds += 2;
            expected.actions.find((action) => action.capability === numeric.capability)!.value =
              changed;
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
