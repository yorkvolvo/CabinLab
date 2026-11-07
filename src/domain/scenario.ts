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
  z.object({ capability: z.literal('climate.frontDefrost'), value: z.boolean() }).strict(),
  z
    .object({ capability: z.literal('media.play'), value: z.enum(['轻音乐', '自然白噪音']) })
    .strict(),
  z.object({ capability: z.literal('media.pause'), value: z.literal(true) }).strict(),
  z.object({ capability: z.literal('window.close'), value: z.literal(true) }).strict(),
  z.object({ capability: z.literal('mirror.heat'), value: z.boolean() }).strict(),
  z.object({ capability: z.literal('seat.heat'), value: z.number().int().min(0).max(3) }).strict(),
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
  z.object({ kind: z.literal('message'), text: z.string().trim().min(1).max(80) }).strict(),
  z
    .object({
      kind: z.literal('pet'),
      maxTemperature: z.number().min(16).max(40),
      minBatteryPercent: z.number().int().min(1).max(100),
    })
    .strict(),
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
      'rainDefog',
      'pickup',
      'passengerWait',
      'rainClose',
      'petWait',
      'rainMirror',
      'rainLink',
      'preheat',
      'precool',
      'preVent',
      'leaveReminder',
      'homeReminder',
    ]),
    name: z.string().min(1).max(40),
    description: z.string().min(1).max(200),
    sourcePrompt: z.string().min(1).max(2000),
    version: z.number().int().min(1).max(999),
    confirmed: z.boolean(),
    trigger: z
      .object({
        signal: z.enum([
          'temperature',
          'illuminance',
          'co2',
          'batteryPercent',
          'rainLevel',
          'pickupDistance',
          'driverExit',
          'petPresent',
          'elapsedSeconds',
          'driverLeft',
          'homeDistance',
        ]),
        operator: z.enum(['gt', 'lt', 'gte']),
        threshold: z.number().min(-50).max(10000),
        holdSeconds: z
          .number()
          .int()
          .min(0)
          .max(60)
          .describe('持续时间指 trigger.holdSeconds：触发条件连续成立的秒数，不是动作超时。'),
      })
      .strict(),
    guard: z.enum(['parked', 'reminder-only']),
    actions: z.array(actionSchema).max(8),
    reminder: reminderSchema.optional(),
    exit: z.enum(['cancel-pending-no-restore', 'cancel-pending-restore-settings']),
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
export const resourceSchema = z.enum(['climate', 'media', 'ambient', 'seat', 'window', 'mirror']);
export type Resource = z.infer<typeof resourceSchema>;
export type TemplateId = Scenario['templateId'];

export function hasWindowResultReminder(scenario: Scenario): boolean {
  return (
    (scenario.templateId === 'rainClose' || scenario.templateId === 'rainLink') &&
    scenario.actions.some((action) => action.capability === 'window.close')
  );
}

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
  'climate.frontDefrost': {
    label: '前挡除雾',
    unit: '',
    range: '开 / 关',
    precondition: '停车且空调已开启',
    result: '前挡除雾开关回读',
    boundary: '回读表示模拟模式已开启，玻璃起雾和清除效果不在台架模型内。',
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
  'seat.heat': {
    label: '主驾座椅加热',
    unit: '档',
    range: '0–3 档，0 为关闭',
    precondition: 'P 挡且车速为 0，允许空座预热',
    result: '模拟座椅加热档位回读',
    boundary: '仅预演主驾档位，不推断实车座椅温度。',
  },
  'window.close': {
    label: '关闭四门车窗',
    unit: '',
    range: '关闭',
    precondition: 'P 挡、车速为 0 且确认窗路无障碍',
    result: '四门车窗全闭回读',
    boundary: '模拟四窗合并反馈，窗路信号用于预演阻止关闭。',
  },
  'mirror.heat': {
    label: '外后视镜加热',
    unit: '',
    range: '开 / 关',
    precondition: 'P 挡且车速为 0',
    result: '外后视镜加热开关回读',
    boundary: '仅模拟开关回读。车型是否支持及镜面除水效果需独立验证。',
  },
};

export const signalLabels = {
  temperature: { label: '车内温度', unit: '°C', min: 16, max: 40 },
  illuminance: { label: '环境照度', unit: 'lx', min: 0, max: 300 },
  co2: { label: 'CO₂ 浓度', unit: 'ppm', min: 400, max: 2000 },
  batteryPercent: { label: '电池电量', unit: '%', min: 0, max: 100 },
  rainLevel: { label: '模拟雨量等级', unit: '级', min: 0, max: 3 },
  pickupDistance: { label: '距接娃点（模拟）', unit: 'm', min: 0, max: 500 },
  driverExit: { label: '主驾离车且仍有乘客', unit: '', min: 0, max: 1 },
  petPresent: { label: '已确认宠物在舱', unit: '', min: 0, max: 1 },
  elapsedSeconds: { label: '预约启动时间', unit: '秒', min: 1, max: 1800 },
  driverLeft: { label: '主驾离车', unit: '', min: 0, max: 1 },
  homeDistance: { label: '距家距离（模拟）', unit: 'm', min: 0, max: 5000 },
};

export const seatLabels = { driver: '主驾', passenger: '副驾' };

export function reminderLabel(reminder: Scenario['reminder']): string {
  if (!reminder) return '无提醒';
  if (reminder.kind === 'message') return reminder.text;
  if (reminder.kind === 'pet')
    return `舱温达到 ${reminder.maxTemperature}°C 或电量降至 ${reminder.minBatteryPercent}% 时提醒`;
  return reminder.kind === 'wake'
    ? `准备完成后 ${reminder.afterSeconds} 秒唤醒`
    : `充电达到 ${reminder.atPercent}% 时提醒`;
}

export const operatorLabels = { gt: '高于', lt: '低于', gte: '达到' } as const;

export function actionLabel(action: Action): string {
  if (action.capability === 'seat.recline')
    return `${seatLabels[action.seat]}座椅后仰 · ${action.value}°`;
  const value =
    typeof action.value === 'boolean'
      ? action.value
        ? '开启'
        : '关闭'
      : `${action.value}${catalog[action.capability].unit}`;
  return action.capability === 'media.pause' || action.capability === 'window.close'
    ? catalog[action.capability].label
    : `${catalog[action.capability].label} · ${value}`;
}

export function resourceOf(capability: Capability): Resource {
  return capability.split('.')[0] as Resource;
}

export function needsClimatePower(capability: Capability): boolean {
  return capability.startsWith('climate.') && capability !== 'climate.power';
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
    if (needsClimatePower(action.capability) && !power) {
      errors.push(`${action.capability} 前必须明确开启空调`);
    }
  }
  if (seen.has('media.play') && seen.has('media.pause'))
    errors.push('同一场景不能同时播放与暂停媒体');
  const { signal, operator, threshold } = scenario.trigger;
  const scheduled = ['preheat', 'precool', 'preVent'].includes(scenario.templateId);
  const leave = scenario.templateId === 'leaveReminder';
  const home = scenario.templateId === 'homeReminder';
  if (
    scheduled !== (signal === 'elapsedSeconds') ||
    (scheduled &&
      (operator !== 'gte' ||
        !Number.isInteger(threshold) ||
        scenario.trigger.holdSeconds !== 0 ||
        scenario.reminder))
  )
    errors.push('预约备车需要设定整秒启动时间，达到时间后立即开始动作');
  if (operator === 'gte' && !scheduled) errors.push('达到或超过仅用于预约时间');
  if (leave !== (signal === 'driverLeft') || (leave && (operator !== 'gt' || threshold !== 0)))
    errors.push('离车提醒需要主驾离车触发');
  if (home !== (signal === 'homeDistance') || (home && (operator !== 'lt' || threshold <= 0)))
    errors.push('到家提醒需要距家距离低于阈值');
  if (
    (leave || home) !== (scenario.reminder?.kind === 'message') ||
    ((leave || home) && scenario.actions.length > 0)
  )
    errors.push('离车和到家场景仅允许文字提醒，不允许车辆动作');
  if (!leave && !home && !scenario.actions.length) errors.push('当前场景需要至少一个动作');
  if (home !== (scenario.guard === 'reminder-only')) errors.push('仅到家提醒允许非停车状态');
  if (scenario.exit === 'cancel-pending-restore-settings') {
    if (scenario.templateId !== 'nap' && scenario.templateId !== 'charging')
      errors.push('只有定时午休和充电等候支持退出恢复');
    if (seen.has('window.close')) errors.push('退出恢复场景不支持自动关窗');
  }
  if (scenario.templateId === 'nap' && scenario.reminder?.kind !== 'wake')
    errors.push('定时午休必须设置唤醒计时');
  if (scenario.templateId === 'charging' && scenario.reminder?.kind !== 'charge')
    errors.push('充电等候必须设置目标电量提醒');
  if (scenario.reminder?.kind === 'charge' && signal !== 'batteryPercent')
    errors.push('充电提醒的触发信号必须为电池电量');
  if (scenario.templateId === 'rainDefog' && (signal !== 'rainLevel' || operator !== 'gt'))
    errors.push('雨天除雾的触发条件必须为模拟雨量等级高于阈值');
  if (scenario.templateId === 'pickup' && (signal !== 'pickupDistance' || operator !== 'lt'))
    errors.push('接娃等候的触发条件必须为模拟距离低于阈值');
  if (
    (scenario.templateId === 'passengerWait' || signal === 'driverExit') &&
    (scenario.templateId !== 'passengerWait' ||
      signal !== 'driverExit' ||
      operator !== 'gt' ||
      threshold !== 0)
  )
    errors.push('乘客等候必须使用主驾离车且仍有乘客的触发条件');
  if (scenario.templateId === 'rainClose' && (signal !== 'rainLevel' || operator !== 'gt'))
    errors.push('雨天自动关窗必须使用模拟雨量等级高于阈值');
  if (scenario.templateId === 'rainMirror' && (signal !== 'rainLevel' || operator !== 'gt'))
    errors.push('雨天后视镜加热必须使用模拟雨量等级高于阈值');
  if (scenario.templateId === 'rainLink' && (signal !== 'rainLevel' || operator !== 'gt'))
    errors.push('雨天联动必须使用模拟雨量等级高于阈值');
  if (
    (scenario.templateId === 'petWait' ||
      signal === 'petPresent' ||
      scenario.reminder?.kind === 'pet') &&
    (scenario.templateId !== 'petWait' ||
      signal !== 'petPresent' ||
      operator !== 'gt' ||
      threshold !== 0 ||
      scenario.reminder?.kind !== 'pet')
  )
    errors.push('宠物留舱必须显式确认宠物在舱，并设置温度及电量提醒');
  if (
    (scenario.templateId === 'passengerWait' ||
      scenario.templateId === 'rainClose' ||
      scenario.templateId === 'rainMirror' ||
      scenario.templateId === 'rainLink') &&
    scenario.reminder
  )
    errors.push('该场景使用原触发条件退出，不支持附加提醒');
  if (signal === 'rainLevel' && !Number.isInteger(threshold))
    errors.push('模拟雨量等级阈值必须是整数');
  const bounds = signalLabels[signal];
  if (threshold < bounds.min || threshold > bounds.max)
    errors.push(`${bounds.label}阈值超出模拟范围`);
  return { scenario: errors.length ? undefined : scenario, errors };
}
