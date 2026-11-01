import { z } from 'zod';

export const actionSchema = z.discriminatedUnion('capability', [
  z.object({ capability: z.literal('climate.power'), value: z.boolean() }).strict(),
  z
    .object({ capability: z.literal('climate.temperature'), value: z.number().min(16).max(30) })
    .strict(),
  z
    .object({ capability: z.literal('climate.fan'), value: z.number().int().min(1).max(5) })
    .strict(),
  z.object({ capability: z.literal('climate.recirculation'), value: z.boolean() }).strict(),
  z
    .object({ capability: z.literal('media.play'), value: z.enum(['轻音乐', '自然白噪音']) })
    .strict(),
  z.object({ capability: z.literal('media.pause'), value: z.literal(true) }).strict(),
  z
    .object({ capability: z.literal('media.volume'), value: z.number().int().min(0).max(60) })
    .strict(),
  z
    .object({ capability: z.literal('ambient.light'), value: z.number().int().min(0).max(100) })
    .strict(),
]);
export const scenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    templateId: z.enum(['rest', 'reading', 'refresh']),
    name: z.string().min(1).max(40),
    description: z.string().min(1).max(200),
    sourcePrompt: z.string().min(1).max(2000),
    version: z.number().int().min(1).max(999),
    confirmed: z.boolean(),
    trigger: z
      .object({
        signal: z.enum(['temperature', 'illuminance', 'co2']),
        operator: z.enum(['gt', 'lt']),
        threshold: z.number().min(-50).max(10000),
        holdSeconds: z.number().int().min(0).max(60),
      })
      .strict(),
    guard: z.literal('parked'),
    actions: z.array(actionSchema).min(1).max(8),
    exit: z.literal('cancel-pending-no-restore'),
    timeoutSeconds: z.number().int().min(2).max(10),
    failurePolicy: z.literal('continue-independent'),
  })
  .strict();

export type Scenario = z.infer<typeof scenarioSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Capability = Action['capability'];
export type Resource = 'climate' | 'media' | 'ambient';
export type TemplateId = Scenario['templateId'];

export const catalog: Record<
  Capability,
  { label: string; unit: string; range: string; precondition: string; result: string }
> = {
  'climate.power': {
    label: '空调电源',
    unit: '',
    range: '开 / 关',
    precondition: 'P 挡且车速为 0',
    result: '电源状态回读',
  },
  'climate.temperature': {
    label: '目标温度',
    unit: '°C',
    range: '16–30 °C',
    precondition: '停车且空调已开启',
    result: '设定值回读（不代表车内已降温）',
  },
  'climate.fan': {
    label: '风量档位',
    unit: '档',
    range: '1–5 档',
    precondition: '停车且空调已开启',
    result: '风量档位回读',
  },
  'climate.recirculation': {
    label: '内循环',
    unit: '',
    range: '开 / 关',
    precondition: '停车且空调已开启',
    result: '循环模式回读',
  },
  'media.play': {
    label: '播放音乐',
    unit: '',
    range: '轻音乐 / 自然白噪音',
    precondition: 'P 挡且车速为 0',
    result: '播放状态回读',
  },
  'media.pause': {
    label: '暂停媒体',
    unit: '',
    range: '暂停',
    precondition: 'P 挡且车速为 0',
    result: '暂停状态回读',
  },
  'media.volume': {
    label: '媒体音量',
    unit: '%',
    range: '0–60 %',
    precondition: 'P 挡且车速为 0',
    result: '音量值回读',
  },
  'ambient.light': {
    label: '阅读灯亮度',
    unit: '%',
    range: '0–100 %',
    precondition: 'P 挡且车速为 0',
    result: '灯光亮度回读',
  },
};

export const signalLabels = {
  temperature: { label: '车内温度', unit: '°C', min: 16, max: 40 },
  illuminance: { label: '环境照度', unit: 'lx', min: 0, max: 300 },
  co2: { label: 'CO₂ 浓度', unit: 'ppm', min: 400, max: 2000 },
};

export function actionLabel(action: Action): string {
  const value =
    typeof action.value === 'boolean'
      ? action.value
        ? '开启'
        : '关闭'
      : `${action.value}${catalog[action.capability].unit}`;
  return action.capability === 'media.pause'
    ? '暂停媒体'
    : `${catalog[action.capability].label} · ${value}`;
}

export function resourceOf(capability: Capability): Resource {
  return capability.split('.')[0] as Resource;
}

export function validateScenario(value: unknown): { scenario?: Scenario; errors: string[] } {
  const parsed = scenarioSchema.safeParse(value);
  if (!parsed.success)
    return { errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const scenario = parsed.data;
  const errors: string[] = [];
  const seen = new Set<Capability>();
  let power = false;
  for (const action of scenario.actions) {
    if (seen.has(action.capability)) errors.push(`重复能力：${action.capability}`);
    seen.add(action.capability);
    if (action.capability === 'climate.power') power = action.value;
    if (
      ['climate.temperature', 'climate.fan', 'climate.recirculation'].includes(action.capability) &&
      !power
    ) {
      errors.push(`${action.capability} 前必须明确开启空调`);
    }
  }
  if (seen.has('media.play') && seen.has('media.pause'))
    errors.push('同一场景不能同时播放与暂停媒体');
  const { signal, threshold } = scenario.trigger;
  const bounds = signalLabels[signal];
  if (threshold < bounds.min || threshold > bounds.max)
    errors.push(`${bounds.label}阈值超出模拟范围`);
  return { scenario: errors.length ? undefined : scenario, errors };
}
