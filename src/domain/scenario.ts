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
  z
    .object({
      capability: z.literal('seat.recline'),
      seat: z.enum(['driver', 'passenger']),
      value: z.number().int().min(0).max(45),
    })
    .strict(),
]);
export const reminderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wake'), afterSeconds: z.number().int().min(1).max(1800) }).strict(),
  z.object({ kind: z.literal('charge'), atPercent: z.number().int().min(1).max(100) }).strict(),
]);
export const scenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    templateId: z.enum([
      'rest',
      'reading',
      'refresh',
      'warmup',
      'cooldown',
      'night',
      'nap',
      'charging',
    ]),
    name: z.string().min(1).max(40),
    description: z.string().min(1).max(200),
    sourcePrompt: z.string().min(1).max(2000),
    version: z.number().int().min(1).max(999),
    confirmed: z.boolean(),
    trigger: z
      .object({
        signal: z.enum(['temperature', 'illuminance', 'co2', 'batteryPercent']),
        operator: z.enum(['gt', 'lt']),
        threshold: z.number().min(-50).max(10000),
        holdSeconds: z
          .number()
          .int()
          .min(0)
          .max(60)
          .describe('持续时间指 trigger.holdSeconds：触发条件连续成立的秒数，不是动作超时。'),
      })
      .strict(),
    guard: z.literal('parked'),
    actions: z.array(actionSchema).min(1).max(8),
    reminder: reminderSchema.optional(),
    exit: z.literal('cancel-pending-no-restore'),
    timeoutSeconds: z
      .number()
      .int()
      .min(2)
      .max(10)
      .describe(
        '动作超时指 timeoutSeconds：单个动作等待回读的秒数，只有明确要求修改动作超时时才改变。',
      ),
    failurePolicy: z.literal('continue-independent'),
  })
  .strict();

export type Scenario = z.infer<typeof scenarioSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Capability = Action['capability'];
export const resourceSchema = z.enum(['climate', 'media', 'ambient', 'seat']);
export type Resource = z.infer<typeof resourceSchema>;
export type TemplateId = Scenario['templateId'];

export const catalog: Record<
  Capability,
  {
    label: string;
    unit: string;
    range: string;
    precondition: string;
    result: string;
    boundary: string;
  }
> = {
  'climate.power': {
    label: '空调电源',
    unit: '',
    range: '开 / 关',
    precondition: 'P 挡且车速为 0',
    result: '电源状态回读',
    boundary: '模拟整车单一电源；接入时需区分前后排、电源与制冷开关。',
  },
  'climate.temperature': {
    label: '目标温度',
    unit: '°C',
    range: '16–30 °C',
    precondition: '停车且空调已开启',
    result: '设定值回读（不代表车内已降温）',
    boundary: '模拟单温区；真实温区、步长与车型范围需另行确认。',
  },
  'climate.fan': {
    label: '风量档位',
    unit: '档',
    range: '1–5 档',
    precondition: '停车且空调已开启',
    result: '风量档位回读',
    boundary: '1–5 档仅为模拟范围；不能直接当作真实车型档位。',
  },
  'climate.recirculation': {
    label: '内循环',
    unit: '',
    range: '开 / 关',
    precondition: '停车且空调已开启',
    result: '循环模式回读',
    boundary: '布尔值仅表示模拟内外循环；真实模式枚举需显式转换。',
  },
  'media.play': {
    label: '播放音乐',
    unit: '',
    range: '轻音乐 / 自然白噪音',
    precondition: 'P 挡且车速为 0',
    result: '播放状态回读',
    boundary: '曲目是合成占位内容；没有真实播放器、账户或内容授权。',
  },
  'media.pause': {
    label: '暂停媒体',
    unit: '',
    range: '暂停',
    precondition: 'P 挡且车速为 0',
    result: '暂停状态回读',
    boundary: '真实播放器的调用结果仍需独立播放状态回读。',
  },
  'media.volume': {
    label: '媒体音量',
    unit: '%',
    range: '0–60 %',
    precondition: 'P 挡且车速为 0',
    result: '音量值回读',
    boundary: '模拟百分比；参考工程使用离散音量级，不能直接透传百分比。',
  },
  'ambient.light': {
    label: '阅读灯亮度',
    unit: '%',
    range: '0–100 %',
    precondition: 'P 挡且车速为 0',
    result: '灯光亮度回读',
    boundary: '仅模拟亮度；参考工程的阅读灯开关不能等同于亮度调节。',
  },
  'seat.recline': {
    label: '座椅后仰角度',
    unit: '°',
    range: '0–45°，座位 seat 为 driver（主驾）或 passenger（副驾）',
    precondition: '停车且对应座位明确有人，执行前再次检查',
    result: '模拟座椅后仰角度回读',
    boundary: '只模拟前排座椅；角度不代表实车行程或防夹能力。',
  },
};

export const signalLabels = {
  temperature: { label: '车内温度', unit: '°C', min: 16, max: 40 },
  illuminance: { label: '环境照度', unit: 'lx', min: 0, max: 300 },
  co2: { label: 'CO₂ 浓度', unit: 'ppm', min: 400, max: 2000 },
  batteryPercent: { label: '电池电量', unit: '%', min: 0, max: 100 },
};

export const seatLabels = { driver: '主驾', passenger: '副驾' };

export function reminderLabel(reminder: Scenario['reminder']): string {
  if (!reminder) return '无提醒';
  return reminder.kind === 'wake'
    ? `准备完成后 ${reminder.afterSeconds} 秒唤醒`
    : `充电达到 ${reminder.atPercent}% 时提醒`;
}

export function actionLabel(action: Action): string {
  if (action.capability === 'seat.recline')
    return `${seatLabels[action.seat]}座椅后仰 · ${action.value}°`;
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
  if (scenario.templateId === 'nap' && scenario.reminder?.kind !== 'wake')
    errors.push('定时午休必须设置唤醒计时');
  if (scenario.templateId === 'charging' && scenario.reminder?.kind !== 'charge')
    errors.push('充电等候必须设置目标电量提醒');
  if (scenario.reminder?.kind === 'charge' && signal !== 'batteryPercent')
    errors.push('充电提醒的触发信号必须为电池电量');
  const bounds = signalLabels[signal];
  if (threshold < bounds.min || threshold > bounds.max)
    errors.push(`${bounds.label}阈值超出模拟范围`);
  return { scenario: errors.length ? undefined : scenario, errors };
}
