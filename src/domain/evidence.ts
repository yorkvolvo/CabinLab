import { z } from 'zod';
import { actionSchema, catalog, resourceSchema, scenarioSchema, type Capability } from './scenario';
import {
  faultSchema,
  replayEvidence,
  runtimeVersionSchema,
  signalsSchema,
  vehicleSchema,
  type RunSnapshot,
} from './runtime';

export const evidenceMaxBytes = 1024 * 1024;
const capabilitySchema = z.enum(Object.keys(catalog) as [Capability, ...Capability[]]);
const timeSchema = z.number().int().min(0).max(3600);
const evidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeVersion: runtimeVersionSchema,
    runId: z.string().min(1).max(256),
    scenario: scenarioSchema,
    initialState: vehicleSchema,
    fault: faultSchema,
    status: z.enum([
      'armed',
      'executing',
      'waiting',
      'completed',
      'partial',
      'uncertain',
      'stopped',
      'cancelled',
    ]),
    time: timeSchema,
    vehicle: vehicleSchema,
    events: z
      .array(
        z
          .object({
            index: z.number().int().min(0),
            time: timeSchema,
            kind: z.enum([
              'armed',
              'condition',
              'reset',
              'triggered',
              'accepted',
              'confirmed',
              'timeout',
              'rejected',
              'unknown',
              'blocked',
              'input',
              'manual',
              'cancelled',
              'stopped',
              'waiting',
              'reminder',
              'completed',
            ]),
            detail: z.string().max(1000),
            capability: capabilitySchema.optional(),
            state: vehicleSchema,
          })
          .strict(),
      )
      .min(1)
      .max(4096),
    commands: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ time: timeSchema, type: z.literal('signals'), patch: signalsSchema }).strict(),
          z.object({ time: timeSchema, type: z.literal('manual'), action: actionSchema }).strict(),
          z.object({ time: timeSchema, type: z.literal('cancel') }).strict(),
        ]),
      )
      .max(1000),
    caveat: z.string().max(500),
    progress: z.number().min(0).max(1),
    holdElapsed: timeSchema,
    locked: z.array(resourceSchema).max(4),
    pending: capabilitySchema.optional(),
    reminderDueAt: timeSchema.optional(),
  })
  .strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function inspectEvidence(text: string): { source: RunSnapshot; replayed: RunSnapshot } {
  if (new TextEncoder().encode(text).byteLength > evidenceMaxBytes)
    throw new Error('证据文件超过 1 MB 限制。');
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法 JSON，请选择导出的运行证据或实验文件。');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('文件不是运行证据。');
  if ('run' in input) {
    if (!input.run) throw new Error('这份实验尚无运行记录。请先预演，再导出证据。');
    const bundle = z
      .object({
        format: z.literal('cabinlab.experiment'),
        schemaVersion: z.literal(1),
        scenario: scenarioSchema,
        run: evidenceSchema,
        verification: z.unknown(),
      })
      .strict()
      .safeParse(input);
    if (!bundle.success) throw new Error('实验文件结构不合法或属于旧格式，请从当前版本重新导出。');
    if (canonical(bundle.data.scenario) !== canonical(bundle.data.run.scenario))
      throw new Error('实验场景与运行证据中的场景不一致。');
    input = bundle.data.run;
  }
  if (
    !input ||
    typeof input !== 'object' ||
    !('runtimeVersion' in input) ||
    !runtimeVersionSchema.safeParse(input.runtimeVersion).success
  )
    throw new Error(
      '缺少或不支持的运行时版本。旧版证据请用原版本查看，或在当前版本重新运行并导出。',
    );
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      '证据结构或参数不合法。仅支持 1 小时内、最多 1000 条输入命令和 4096 条事件的记录。',
    );
  const source = parsed.data;
  let last = 0;
  for (const command of source.commands) {
    if (command.time < last || command.time > source.time)
      throw new Error('输入命令时间不连续或超过记录终点。');
    last = command.time;
  }
  last = 0;
  for (const [index, event] of source.events.entries()) {
    if (event.index !== index || event.time < last || event.time > source.time)
      throw new Error('事件索引或时间顺序不合法。');
    last = event.time;
  }
  let replayed: RunSnapshot;
  try {
    replayed = replayEvidence(source).snapshot();
  } catch {
    throw new Error('场景或输入命令无法在当前运行时重放。');
  }
  const fields = [
    'scenario',
    'initialState',
    'fault',
    'status',
    'time',
    'vehicle',
    'events',
    'commands',
    'progress',
    'holdElapsed',
    'locked',
    'pending',
    'reminderDueAt',
    'caveat',
  ] as const;
  const mismatch = fields.filter((key) => canonical(source[key]) !== canonical(replayed[key]));
  if (mismatch.length)
    throw new Error(
      `重放与记录不一致（${mismatch.join('、')}）。文件可能被修改或不兼容，不能作为本次复现成功的证据。`,
    );
  return { source, replayed };
}
