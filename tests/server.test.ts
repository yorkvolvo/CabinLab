import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { compile, configFromEnv, type ProviderConfig } from '../server/provider';
import { cloneTemplate } from '../src/domain/templates';
import { CompileError, modelContext } from '../src/domain/compiler';

const request = { prompt: '停车休息，太热就开空调', templateId: 'rest' };
const modelConfig: ProviderConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://model.example.test/v1',
  model: 'test-model',
  apiKey: 'test-only-not-a-real-key',
};

test('默认使用 demo，即使存在 key 也不自动调用模型', async () => {
  assert.deepEqual(configFromEnv({ LLM_API_KEY: 'unused' }), { provider: 'demo' });
  let fetched = false;
  const result = await compile(request, { provider: 'demo' }, async () => {
    fetched = true;
    throw new Error('不应调用');
  });
  assert.equal(fetched, false);
  assert.equal(result.mode, 'demo');
});
test('选择模板后本地模式保留所选类型，自由创建仍按需求匹配', async () => {
  const template = cloneTemplate('rainLink');
  const locked = { templateId: 'rainLink', templateLocked: true, prompt: template.sourcePrompt };
  const result = await compile(locked, { provider: 'demo' });
  assert.equal(result.draft.templateId, 'rainLink');
  await assert.rejects(
    compile({ ...locked, prompt: '停车看书打开阅读灯' }, { provider: 'demo' }),
    /与所选模板不匹配/,
  );
  const free = await compile({ ...request, prompt: '停车看书打开阅读灯' }, { provider: 'demo' });
  assert.equal(free.draft.templateId, 'reading');
});

test('模型收到所选模板及其默认配置，返回其他模板时不给出草案', async () => {
  const template = cloneTemplate('nap');
  const calls: string[] = [];
  await assert.rejects(
    compile(
      { templateId: 'nap', templateLocked: true, prompt: template.sourcePrompt },
      modelConfig,
      async (_url, init) => {
        const { messages } = JSON.parse(String(init?.body));
        calls.push(messages[0].content);
        return modelResponse(cloneTemplate('rest'));
      },
    ),
    /没有按所选模板生成/,
  );
  assert.equal(calls.length, 2);
  for (const system of calls) {
    assert.match(system, /用户已明确选择「定时午休」，必须使用 templateId=nap/);
    assert.ok(
      system.includes(
        JSON.stringify({ ...modelContext(template), guard: template.guard, exit: template.exit }),
      ),
    );
  }
});

test('OpenAI 直连只使用独立密钥和官方端点，启用 JSON 对象模式', async () => {
  assert.throws(() => configFromEnv({ LLM_PROVIDER: 'openai' }), /OPENAI_API_KEY/);
  const config = configFromEnv({
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'direct-test-key',
    OPENAI_MODEL: 'direct-test-model',
    LLM_BASE_URL: 'https://gateway.example.test',
    LLM_API_KEY: 'gateway-test-key',
    LLM_SECONDARY_MODEL: 'gateway-test-model',
  });
  const urls: string[] = [];
  const scene = cloneTemplate('rest');
  for (const intent of ['create', 'modify'] as const) {
    const result = await compile(
      { ...request, intent, ...(intent === 'modify' ? { baseScenario: scene } : {}) },
      config,
      async (input, init) => {
        urls.push(String(input));
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'direct-test-model');
        assert.deepEqual(body.response_format, { type: 'json_object' });
        assert.match(body.messages[0].content, /JSON/);
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer direct-test-key');
        return modelResponse(
          intent === 'modify' ? { patch: { trigger: { holdSeconds: 8 } } } : scene,
        );
      },
    );
    assert.equal(result.mode, 'model');
  }
  assert.deepEqual(urls, Array(2).fill('https://api.openai.com/v1/chat/completions'));
});
test('模型配置缺失和不安全的远程 HTTP 会被拒绝', () => {
  assert.throws(() => configFromEnv({ LLM_PROVIDER: 'unknown' }));
  assert.throws(() => configFromEnv({ LLM_PROVIDER: 'openai-compatible' }));
  assert.throws(() =>
    configFromEnv({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://example.test/v1',
      LLM_MODEL: 'model',
      LLM_API_KEY: 'test',
    }),
  );
  assert.doesNotThrow(() =>
    configFromEnv({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://127.0.0.1:8080/v1',
      LLM_MODEL: 'local',
      LLM_API_KEY: 'local',
    }),
  );
});
test('兼容接口通过服务端鉴权；返回场景必须再确认', async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://model.example.test/v1/chat/completions');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      'Bearer test-only-not-a-real-key',
    );
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'test-model');
    assert.equal(body.messages[1].content, request.prompt);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(cloneTemplate('rest')) } }],
      }),
    );
  };
  const result = await compile(request, modelConfig, fakeFetch);
  assert.equal(result.mode, 'model');
  assert.equal(result.draft.confirmed, false);
  assert.ok(!JSON.stringify(result).includes(modelConfig.apiKey!));
});
test('上游错误、JSON 结构异常和无效能力均会失败', async () => {
  const responses = [
    new Response('error', { status: 429 }),
    new Response('not json'),
    new Response(JSON.stringify({ choices: [] })),
    new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })),
  ];
  for (const response of responses)
    await assert.rejects(compile(request, modelConfig, async () => response));
});
test('API 参数长度与额外字段被拒绝', async () => {
  for (const invalid of [
    { ...request, prompt: 'x' },
    { ...request, prompt: 'x'.repeat(2001) },
    { ...request, templateId: 'drive' },
    { ...request, baseUrl: 'https://evil.example' },
  ])
    await assert.rejects(compile(invalid, { provider: 'demo' }));
});
test('HTTP 接口健康检查、编译、同源校验及体积限制', async (t) => {
  const server = createApp({ provider: 'demo' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, 'demo');
  const valid = await fetch(`${base}/api/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(request),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).draft.confirmed, false);
  const cross = await fetch(`${base}/api/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' },
    body: JSON.stringify(request),
  });
  assert.equal(cross.status, 403);
  const wrongType = await fetch(`${base}/api/compile`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  assert.equal(wrongType.status, 415);
  const malformed = await fetch(`${base}/api/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  const large = await fetch(`${base}/api/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, prompt: 'a'.repeat(30000) }),
  });
  assert.equal(large.status, 413);
  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
});
test('模型服务失败只返回受控错误，不泄漏上游密钥内容', async (t) => {
  const server = createApp(modelConfig, async () => {
    throw new Error('test-only-not-a-real-key');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/compile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(modelConfig.apiKey!));
});

test('超过 100 KB 的模型响应流被中止', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(100001));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    compile(request, modelConfig, async () => new Response(stream)),
    /大小限制/,
  );
  assert.equal(cancelled, true);
});

test('API 拒绝伪造的非本地主机名', async (t) => {
  const server = createApp({ provider: 'demo' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  // Fetch 会重写 Host；用 HTTP 客户端发送真实的伪造 Host。
  const status = await new Promise<number | undefined>((resolve, reject) => {
    httpGet(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`,
      { headers: { Host: 'attacker.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on('error', reject);
  });
  assert.equal(status, 403);
});

test('同时两个编译请求占用时第三个被拒绝，完成后可重试', { timeout: 5000 }, async (t) => {
  const resolvers: Array<(response: Response) => void> = [];
  let allStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const fakeFetch: typeof fetch = () =>
    new Promise<Response>((resolve) => {
      resolvers.push(resolve);
      if (resolvers.length === 2) allStarted();
    });
  const server = createApp(modelConfig, fakeFetch).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/compile`;
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  const first = send();
  const second = send();
  await started;
  assert.equal((await send()).status, 429);
  const response = () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(cloneTemplate('rest')) } }],
      }),
    );
  resolvers.forEach((resolve) => resolve(response()));
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  const retry = send();
  while (resolvers.length < 3) await new Promise((resolve) => setTimeout(resolve, 1));
  resolvers[2](response());
  assert.equal((await retry).status, 200);
});

test('浏览器取消请求会传递到上游模型调用', { timeout: 5000 }, async (t) => {
  let markStarted: () => void = () => {};
  let markAborted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const fakeFetch: typeof fetch = async (_url, init) => {
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          markAborted();
          reject(new Error('cancelled'));
        },
        { once: true },
      );
    });
  };
  const server = createApp(modelConfig, fakeFetch).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending);
  await started;
  controller.abort();
  await rejected;
  await aborted;
});

const modelResponse = (value: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

test('模型修改请求携带完整基准，未提及字段保留且必须重新确认', async () => {
  const baseScenario = cloneTemplate('rest');
  baseScenario.version = 4;
  const result = await compile(
    { ...request, intent: 'modify', prompt: '把持续时间改为 8 秒', baseScenario },
    modelConfig,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.messages[1].content);
      assert.deepEqual(context.baseScenario, modelContext(baseScenario));
      assert.equal(context.instruction, '把持续时间改为 8 秒');
      return modelResponse({
        ...baseScenario,
        trigger: { ...baseScenario.trigger, holdSeconds: 8 },
      });
    },
  );
  assert.equal(result.draft.trigger.holdSeconds, 8);
  assert.deepEqual(result.draft.actions, baseScenario.actions);
  assert.equal(result.draft.confirmed, false);
});
test('修改请求不能省略基准、伪造确认或更换模板归属', async () => {
  for (const baseScenario of [
    undefined,
    { ...cloneTemplate('rest'), confirmed: false },
    cloneTemplate('reading'),
  ])
    await assert.rejects(compile({ ...request, intent: 'modify', baseScenario }, modelConfig));
  await assert.rejects(
    compile(
      { ...request, intent: 'modify', baseScenario: cloneTemplate('rest') },
      modelConfig,
      async () => modelResponse(cloneTemplate('reading')),
    ),
    /归属/,
  );
});
test('模型可以返回澄清，模糊需求不会产生可执行草案', async () => {
  await assert.rejects(
    compile(request, modelConfig, async () =>
      modelResponse({ clarification: '请明确持续多少秒。' }),
    ),
    (error: unknown) => error instanceof CompileError && error.code === 'needs_clarification',
  );
});

for (const [status, code] of [
  [401, 'provider_auth'],
  [403, 'provider_auth'],
  [429, 'provider_rate_limit'],
  [500, 'provider_unavailable'],
] as const)
  test(`上游 HTTP ${status} 返回可操作的错误类别，不透出响应内容`, async () => {
    let calls = 0;
    await assert.rejects(
      compile(request, modelConfig, async () => {
        calls++;
        return new Response('private-upstream-data', { status });
      }),
      (error: unknown) =>
        error instanceof CompileError &&
        error.code === code &&
        !error.message.includes('private-upstream-data'),
    );
    assert.equal(calls, 1);
  });

test('无效的模型 JSON 和非法场景返回 provider_output', async () => {
  for (const response of [
    new Response('not-json'),
    modelResponse({}),
    modelResponse({
      ...cloneTemplate('rest'),
      actions: [{ capability: 'vehicle.drive', value: true }],
    }),
  ])
    await assert.rejects(
      compile(request, modelConfig, async () => response),
      (error: unknown) => error instanceof CompileError && error.code === 'provider_output',
    );
});
test('模型在响应头之前超时，会取消调用并返回明确超时原因', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const pending = compile(
    request,
    modelConfig,
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        deadline.abort(new DOMException('deadline', 'TimeoutError'));
      }),
  );
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CompileError && error.code === 'provider_timeout',
  );
});
test('模型响应头之后持续不结束，超时会中止响应流', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      deadline.abort(new DOMException('deadline', 'TimeoutError'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    compile(request, modelConfig, async () => new Response(stream)),
    (error: unknown) => error instanceof CompileError && error.code === 'provider_timeout',
  );
  assert.equal(cancelled, true);
});
test('用户取消响应流时关闭读取器，并区别于模型超时', async () => {
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
    compile(request, modelConfig, async () => new Response(stream), controller.signal),
    (error: unknown) => error instanceof CompileError && error.code === 'cancelled',
  );
  assert.equal(cancelled, true);
});
test('HTTP 对本地不支持需求返回 422，修正后仍可继续', async (t) => {
  const server = createApp({ provider: 'demo' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/compile`;
  const send = (body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const unsupported = await send({ ...request, prompt: '停车时打开车窗' });
  assert.equal(unsupported.status, 422);
  assert.equal((await unsupported.json()).code, 'unsupported_request');
  const valid = await send({
    ...request,
    intent: 'modify',
    prompt: '持续时间改为 0 秒',
    baseScenario: cloneTemplate('rest'),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).draft.trigger.holdSeconds, 0);
});

test('最长中文需求与完整基准同时发送时仍在请求体限制内', async (t) => {
  const baseScenario = cloneTemplate('rest');
  baseScenario.sourcePrompt = '停车'.repeat(1000);
  const server = createApp(modelConfig, async () => modelResponse(baseScenario)).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/compile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...request,
        intent: 'modify',
        prompt: '修改'.repeat(1000),
        baseScenario,
      }),
    },
  );
  assert.equal(response.status, 200);
});
