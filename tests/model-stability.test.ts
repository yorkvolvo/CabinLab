import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, configFromEnv, type ProviderConfig } from '../server/provider';
import { cloneTemplate } from '../src/domain/templates';
import { modelContext, parseModelModification } from '../src/domain/compiler';

test('修改请求复用基准结构，约束提示不重复发送整份生成 Schema', async () => {
  const config: ProviderConfig = {
    provider: 'anthropic',
    baseUrl: 'https://model.example.test',
    model: 'test-model',
    apiKey: 'test-only-not-a-real-key',
  };
  const baseScenario = cloneTemplate('rest');
  let creationBytes = 0;
  let modificationBytes = 0;
  for (const intent of ['create', 'modify'] as const) {
    await compile(
      {
        prompt: '空调目标温度改为 22°C',
        templateId: 'rest',
        intent,
        ...(intent === 'modify' ? { baseScenario } : {}),
      },
      config,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const bytes = Buffer.byteLength(body.system);
        if (intent === 'create') creationBytes = bytes;
        else {
          modificationBytes = bytes;
          assert.deepEqual(
            JSON.parse(body.messages[0].content).baseScenario,
            modelContext(baseScenario),
          );
          assert.match(body.system, /16–30/);
          assert.match(body.system, /climate.temperature/);
        }
        return new Response(
          JSON.stringify({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(baseScenario) }],
          }),
        );
      },
    );
  }
  assert.ok(modificationBytes < creationBytes / 2, '修改重复发送了完整生成约束，容易引发长推理');
});

test('模型只返回改动字段，服务器保留全部未提及字段且不修改基准', () => {
  const base = cloneTemplate('rest');
  const original = structuredClone(base);
  const result = parseModelModification(
    { patch: { trigger: { holdSeconds: 8 } } },
    '持续时间改为8秒',
    base,
  );
  assert.deepEqual(base, original);
  assert.deepEqual(result.draft.trigger, { ...base.trigger, holdSeconds: 8 });
  assert.deepEqual(result.draft.actions, base.actions);
  assert.equal(result.draft.description, base.description);
  assert.equal(result.draft.confirmed, false);
  for (const patch of [
    { id: 'other' },
    { name: '不相关的新名字' },
    { description: '不相关的新说明' },
    { confirmed: true },
    { exit: 'restore' },
    { trigger: { holdSeconds: -1 } },
    { actions: [{ capability: 'climate.temperature', value: 24 }] },
    { actions: [{ capability: 'vehicle.drive', value: true }] },
  ])
    assert.throws(() => parseModelModification({ patch }, '修改场景', base));
  assert.throws(() =>
    parseModelModification({ ...base, description: '改写说明' }, '只改持续时间', base),
  );
});

test('按服务支持的原生字段显式传递推理强度，非法值在启动时拒绝', async () => {
  const env = {
    LLM_PROVIDER: 'anthropic',
    LLM_BASE_URL: 'https://model.example.test',
    LLM_MODEL: 'test-model',
    LLM_API_KEY: 'test-only-not-a-real-key',
  };
  const config = configFromEnv({ ...env, LLM_REASONING_EFFORT: 'low' });
  assert.throws(() => configFromEnv({ ...env, LLM_REASONING_EFFORT: 'disabled' }));
  await compile(
    { prompt: '停车休息时太热开空调', templateId: 'rest' },
    config,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.reasoning_effort, 'low');
      assert.match(body.system, /Reasoning Effort: Low/);
      assert.equal(body.thinking, undefined);
      return new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(cloneTemplate('rest')) }],
        }),
      );
    },
  );
});

test('原生请求通过流式传输保持连接，完整结束后才加载候选场景', async () => {
  const result = await compile(
    { prompt: '停车休息时太热开空调', templateId: 'rest' },
    {
      provider: 'anthropic',
      baseUrl: 'https://model.example.test',
      model: 'test',
      apiKey: 'test-key',
    },
    async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      const events = [
        { type: 'message_start' },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'private-thought' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: JSON.stringify(cloneTemplate('rest')) },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ];
      return new Response(
        events
          .map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
          .join(''),
        {
          headers: { 'Content-Type': 'text/event-stream' },
        },
      );
    },
  );
  assert.equal(result.draft.confirmed, false);
  assert.ok(!JSON.stringify(result).includes('private-thought'));
});

test('完整响应含非法 JSON 时定向修复一次，仍须确认且保留原始需求', async () => {
  let calls = 0;
  const prompt = '持续时间改为 8 秒';
  const result = await compile(
    { prompt, templateId: 'rest', intent: 'modify', baseScenario: cloneTemplate('rest') },
    { provider: 'anthropic', baseUrl: 'https://model.example.test', model: 'test', apiKey: 'test' },
    async () =>
      new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text:
                ++calls === 1
                  ? '{"patch": expression()}'
                  : '{"patch":{"trigger":{"holdSeconds":8}}}',
            },
          ],
        }),
      ),
  );
  assert.equal(calls, 2);
  assert.equal(result.draft.sourcePrompt, prompt);
  assert.equal(result.draft.trigger.holdSeconds, 8);
  assert.equal(result.draft.confirmed, false);
  assert.match(result.message, /修复/);
});

test('连续非法响应最多修复一次，取消不触发修复', async () => {
  for (const cancel of [false, true]) {
    let calls = 0;
    const controller = new AbortController();
    await assert.rejects(
      compile(
        { prompt: '停车休息时太热开空调', templateId: 'rest' },
        {
          provider: 'anthropic',
          baseUrl: 'https://model.example.test',
          model: 'test',
          apiKey: 'test',
        },
        async () => {
          calls++;
          if (cancel) controller.abort();
          return new Response(
            JSON.stringify({
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'expression()' }],
            }),
          );
        },
        controller.signal,
      ),
    );
    assert.equal(calls, cancel ? 1 : 2);
  }
});

test('修复仍受最初的总截止时间限制，不能重置用户等待时间', async (t) => {
  const deadlines: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', () => {
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  let calls = 0;
  await assert.rejects(
    compile(
      { prompt: '停车休息时太热开空调', templateId: 'rest' },
      {
        provider: 'anthropic',
        baseUrl: 'https://model.example.test',
        model: 'test',
        apiKey: 'test',
      },
      async (_url, init) => {
        if (++calls === 1)
          return new Response(
            JSON.stringify({
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'invalid' }],
            }),
          );
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
          deadlines[0].abort(new DOMException('deadline', 'TimeoutError'));
        });
      },
    ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'provider_timeout',
  );
  assert.equal(calls, 2);
});
