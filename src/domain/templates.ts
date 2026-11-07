import type { Scenario, TemplateId } from './scenario';

const base = {
  schemaVersion: 1,
  version: 1,
  confirmed: true,
  guard: 'parked',
  exit: 'cancel-pending-no-restore',
  timeoutSeconds: 3,
  failurePolicy: 'continue-independent',
} as const;

export const templates: Record<TemplateId, Scenario> = {
  rest: {
    ...base,
    id: 'rest',
    templateId: 'rest',
    name: '午间休憩',
    description: '停车太热时，降温、轻音乐，给自己一个舒适的休息空间。',
    sourcePrompt: '停车休息时，车内持续太热就开空调降温，放点轻音乐；我开始开车就结束休息模式。',
    trigger: { signal: 'temperature', operator: 'gt', threshold: 28, holdSeconds: 10 },
    actions: [
      { capability: 'climate.power', value: true },
      { capability: 'climate.temperature', value: 24 },
      { capability: 'media.play', value: '轻音乐' },
      { capability: 'media.volume', value: 20 },
    ],
  },
  reading: {
    ...base,
    id: 'reading',
    templateId: 'reading',
    name: '静心阅读',
    description: '停好车，光线暗下来，打开阅读灯并暂停音乐。',
    sourcePrompt: '停车看书时，环境比较暗就打开阅读灯，暂停音乐；开始开车就停止这个场景。',
    trigger: { signal: 'illuminance', operator: 'lt', threshold: 100, holdSeconds: 3 },
    actions: [
      { capability: 'ambient.light', value: 60 },
      { capability: 'media.pause', value: true },
    ],
  },
  refresh: {
    ...base,
    id: 'refresh',
    templateId: 'refresh',
    name: '清新座舱',
    description: '停车等待时，让外循环和适度送风带来清新的空气。',
    sourcePrompt: '停车等人时，二氧化碳持续偏高就开空调和外循环，把风量设到三档。',
    trigger: { signal: 'co2', operator: 'gt', threshold: 1000, holdSeconds: 5 },
    actions: [
      { capability: 'climate.power', value: true },
      { capability: 'climate.recirculation', value: false },
      { capability: 'climate.fan', value: 3 },
    ],
  },
  warmup: {
    ...base,
    id: 'warmup',
    templateId: 'warmup',
    name: '低温暖舱',
    description: '停车时车内持续偏冷，开启暖风和适度送风，等待温暖的出发时刻。',
    sourcePrompt:
      '停车等人时，车内持续偏冷就开启空调暖舱，调到舒适温度和适度风量；开始开车就结束场景。',
    trigger: { signal: 'temperature', operator: 'lt', threshold: 18, holdSeconds: 5 },
    actions: [
      { capability: 'climate.power', value: true },
      { capability: 'climate.temperature', value: 26 },
      { capability: 'climate.fan', value: 2 },
    ],
  },
  cooldown: {
    ...base,
    id: 'cooldown',
    templateId: 'cooldown',
    name: '强力降温',
    description: '停好车后车内持续闷热，以较大风量降温，不自动播放媒体。',
    sourcePrompt: '停车后车内持续闷热时，快速降温并提高风量，保持外循环；开始开车就结束场景。',
    trigger: { signal: 'temperature', operator: 'gt', threshold: 32, holdSeconds: 3 },
    actions: [
      { capability: 'climate.power', value: true },
      { capability: 'climate.temperature', value: 22 },
      { capability: 'climate.fan', value: 5 },
      { capability: 'climate.recirculation', value: false },
    ],
  },
  night: {
    ...base,
    id: 'night',
    templateId: 'night',
    name: '夜间放松',
    description: '停车光线持续变暗后，以柔和灯光和低音量白噪音营造安静空间。',
    sourcePrompt:
      '停车夜间放松时，环境持续较暗就调暗阅读灯，播放自然白噪音并降低音量；开始开车就结束场景。',
    trigger: { signal: 'illuminance', operator: 'lt', threshold: 60, holdSeconds: 5 },
    actions: [
      { capability: 'ambient.light', value: 20 },
      { capability: 'media.volume', value: 12 },
      { capability: 'media.play', value: '自然白噪音' },
    ],
  },
};

export function cloneTemplate(id: TemplateId): Scenario {
  return structuredClone(templates[id]);
}
