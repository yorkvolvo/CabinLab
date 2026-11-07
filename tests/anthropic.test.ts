import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, configFromEnv, type ProviderConfig } from '../server/provider';
import { cloneTemplate } from '../src/domain/templates';
import { CompileError } from '../src/domain/compiler';

const config: ProviderConfig = {
  provider: 'anthropic',
  baseUrl: 'https://model.example.test/gateway',
  model: 'test-model',
  apiKey: 'test-only-not-a-real-key',
};
const request = { prompt: '停车休息，车内太热就开空调', templateId: 'rest' };
const message = (value: unknown) =>
  new Response(
    JSON.stringify({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(value) }],
    }),
  );

test('原生 Messages 配置保留网关路径，必须完整且不能使用远程明文 HTTP', () => {
  assert.deepEqual(
    configFromEnv({
      LLM_PROVIDER: 'anthropic',
      LLM_BASE_URL: config.baseUrl + '/',
      LLM_MODEL: config.model,
      LLM_API_KEY: config.apiKey,
    }),
    config,
  );
  assert.throws(() => configFromEnv({ LLM_PROVIDER: 'anthropic' }));
  assert.throws(() =>
    configFromEnv({
      LLM_PROVIDER: 'anthropic',
      LLM_BASE_URL: 'http://model.example.test',
      LLM_MODEL: 'test-model',
      LLM_API_KEY: 'test-key',
    }),
  );
});

test('模型超时可按服务延迟配置，非法范围会在启动时拒绝', () => {
  const env = {
    LLM_PROVIDER: 'anthropic',
    LLM_BASE_URL: config.baseUrl,
    LLM_MODEL: config.model,
    LLM_API_KEY: config.apiKey,
  };
  assert.equal(configFromEnv({ ...env, LLM_TIMEOUT_MS: '120000' }).timeoutMs, 120000);
  for (const value of ['NaN', '0', '-1', '120001', '1000.5'])
    assert.throws(() => configFromEnv({ ...env, LLM_TIMEOUT_MS: value }));
});

test('原生 Messages 使用顶层 system、用户消息、API key 与输出限制，拒绝重定向', async () => {
  const result = await compile(request, config, async (url, init) => {
    assert.equal(url, config.baseUrl + '/v1/messages');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], config.apiKey);
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers.Authorization, undefined);
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model);
    assert.equal(body.max_tokens, 16384);
    assert.match(body.system, /JSON Schema/);
    assert.deepEqual(body.messages, [{ role: 'user', content: request.prompt }]);
    return message(cloneTemplate('rest'));
  });
  assert.equal(result.mode, 'model');
  assert.equal(result.draft.confirmed, false);
  assert.ok(!JSON.stringify(result).includes(config.apiKey!));
});

test('原生 Messages 修改携带当前版本，结果保留归属并重新等待确认', async () => {
  const baseScenario = { ...cloneTemplate('rest'), version: 3 };
  const result = await compile(
    { ...request, prompt: '把持续时间改为 8 秒', intent: 'modify', baseScenario },
    config,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(JSON.parse(body.messages[0].content), {
        instruction: '把持续时间改为 8 秒',
        baseScenario,
      });
      return message({ ...baseScenario, trigger: { ...baseScenario.trigger, holdSeconds: 8 } });
    },
  );
  assert.equal(result.draft.trigger.holdSeconds, 8);
  assert.deepEqual(result.draft.actions, baseScenario.actions);
  assert.equal(result.draft.confirmed, false);
  await assert.rejects(
    compile({ ...request, intent: 'modify', baseScenario }, config, async () =>
      message(cloneTemplate('reading')),
    ),
    /归属/,
  );
});

test('原生 Messages 多段文本合并，不把 thinking 内容当作场景或返回给前端', async () => {
  const json = JSON.stringify(cloneTemplate('rest'));
  const result = await compile(
    request,
    config,
    async () =>
      new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'private-thought' },
            { type: 'redacted_thinking', data: 'private-data' },
            { type: 'text', text: json.slice(0, 50) },
            { type: 'text', text: json.slice(50) },
          ],
        }),
      ),
  );
  assert.equal(result.draft.templateId, 'rest');
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('原生 Messages 澄清保持 needs_clarification，不产生候选场景', async () => {
  await assert.rejects(
    compile(request, config, async () => message({ clarification: '请明确温度与持续时间。' })),
    (error: unknown) => error instanceof CompileError && error.code === 'needs_clarification',
  );
});

for (const [name, envelope] of [
  [
    '截断',
    {
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: JSON.stringify(cloneTemplate('rest')) }],
    },
  ],
  ['工具调用', { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'execute' }] }],
  ['空内容', { stop_reason: 'end_turn', content: [] }],
  ['错误文本类型', { stop_reason: 'end_turn', content: [{ type: 'text', text: 123 }] }],
  ['错误 JSON', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not-json' }] }],
  [
    '未知能力',
    {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...cloneTemplate('rest'),
            actions: [{ capability: 'vehicle.drive', value: true }],
          }),
        },
      ],
    },
  ],
] as const)
  test(`原生 Messages ${name}明确拒绝`, async () => {
    await assert.rejects(
      compile(request, config, async () => new Response(JSON.stringify(envelope))),
      (error: unknown) => error instanceof CompileError && error.code === 'provider_output',
    );
  });

for (const [status, code] of [
  [401, 'provider_auth'],
  [429, 'provider_rate_limit'],
  [500, 'provider_unavailable'],
] as const)
  test(`原生 Messages HTTP ${status}不泄漏上游响应且不自动重试`, async () => {
    let calls = 0;
    await assert.rejects(
      compile(request, config, async () => {
        calls++;
        return new Response('private-upstream-data', { status });
      }),
      (error: unknown) =>
        error instanceof CompileError && error.code === code && !error.message.includes('private-'),
    );
    assert.equal(calls, 1);
  });

test('原生 Messages 响应流读取途中取消，释放上游读取器', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(reader) {
      reader.enqueue(new TextEncoder().encode('{'));
    },
    pull() {
      controller.abort();
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    compile(request, config, async () => new Response(stream), controller.signal),
    (error: unknown) => error instanceof CompileError && error.code === 'cancelled',
  );
  assert.equal(cancelled, true);
});
