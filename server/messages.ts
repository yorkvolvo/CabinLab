import { z } from 'zod';
import { CompileError } from '../src/domain/compiler';

const eventSchema = z.object({
  type: z.string(),
  index: z.number().int().min(0).max(63).optional(),
  content_block: z.object({ type: z.string(), text: z.string().max(30000).optional() }).optional(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.string().max(30000).optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
});

export function parseMessagesStream(raw: string) {
  let started = false;
  let stopped = false;
  let stopReason: string | null = null;
  const blocks = new Map<number, { type: string; text?: string; closed: boolean }>();
  function invalid(): never {
    throw new Error('原生模型事件流不完整或顺序不合法');
  }
  for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    const event = eventSchema.parse(JSON.parse(data));
    if (event.type === 'ping') continue;
    if (event.type === 'error')
      throw new CompileError(
        'provider_unavailable',
        '模型服务在生成途中返回错误，未加载候选场景。',
        502,
      );
    if (stopped) invalid();
    if (event.type === 'message_start') {
      if (started) invalid();
      started = true;
    } else if (
      ['content_block_start', 'content_block_delta', 'content_block_stop'].includes(event.type)
    ) {
      if (!started || event.index === undefined) invalid();
      const index = event.index;
      if (event.type === 'content_block_start') {
        if (blocks.has(index) || !event.content_block) invalid();
        blocks.set(index, { ...event.content_block, closed: false });
      } else {
        const block = blocks.get(index);
        if (!block || block.closed) invalid();
        if (event.type === 'content_block_stop') block.closed = true;
        else if (event.delta?.type === 'text_delta') {
          if (block.type !== 'text' || event.delta.text === undefined) invalid();
          block.text = (block.text ?? '') + event.delta.text;
          if (block.text.length > 30000) invalid();
        }
      }
    } else if (event.type === 'message_delta') {
      if (!started) invalid();
      stopReason = event.delta?.stop_reason ?? stopReason;
    } else if (event.type === 'message_stop') {
      if (!started || !stopReason || [...blocks.values()].some((block) => !block.closed)) invalid();
      stopped = true;
    }
  }
  if (!stopped) invalid();
  return {
    stop_reason: stopReason,
    content: [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => ({ type: block.type, text: block.text })),
  };
}
