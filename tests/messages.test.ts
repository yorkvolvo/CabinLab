import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessagesStream } from '../server/messages';
import { compile } from '../server/provider';
import { cloneTemplate } from '../src/domain/templates';

const events = (text = JSON.stringify(cloneTemplate('rest'))) => [
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];
const wire = (items: unknown[]) =>
  items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');

for (const [name, items] of [
  ['缺少终态', events().slice(0, -1)],
  ['缺少开始', events().slice(1)],
  ['重复开始', [events()[0], ...events()]],
  ['重复内容块', [events()[0], events()[1], events()[1], ...events().slice(2)]],
  ['内容块关闭后仍写入', [...events().slice(0, 4), events()[2], ...events().slice(4)]],
  ['结束后仍写入', [...events(), events()[2]]],
] as const)
  test(`事件流拒绝${name}，不将已有文本当作完成`, () => {
    assert.throws(() => parseMessagesStream(wire([...items])));
  });

test('流中错误只返回受控消息，不透出上游内容', () => {
  assert.throws(
    () =>
      parseMessagesStream(wire([{ type: 'error', error: { message: 'private-key-and-data' } }])),
    (error: unknown) =>
      error instanceof Error &&
      /途中返回错误/.test(error.message) &&
      !error.message.includes('private-'),
  );
});

test('文本按事件块索引还原，ping 和新增元数据事件不进入场景内容', () => {
  const input = [
    { type: 'message_start' },
    { type: 'ping' },
    { type: 'future_metadata', text: 'not-scenario' },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'B' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  assert.deepEqual(
    parseMessagesStream(wire(input)).content.map((block) => block.text),
    ['A', 'B'],
  );
});

test('跨 UTF-8 字符和事件边界的分片仍能形成同一候选，截断终态拒绝', async () => {
  const config = {
    provider: 'anthropic' as const,
    baseUrl: 'https://model.example.test',
    model: 'test',
    apiKey: 'test',
  };
  for (const truncated of [false, true]) {
    const input = events();
    if (truncated) input[4] = { type: 'message_delta', delta: { stop_reason: 'max_tokens' } };
    const bytes = new TextEncoder().encode(wire(input));
    const request = compile(
      { prompt: '停车休息时太热开空调', templateId: 'rest' },
      config,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
        ),
    );
    if (truncated) await assert.rejects(request, /未完整结束/);
    else assert.equal((await request).draft.name, cloneTemplate('rest').name);
  }
});
