import { cloneTemplate, templates } from './templates';
import { z } from 'zod';
import {
  reminderLabel,
  scenarioSchema,
  signalLabels,
  validateScenario,
  type Scenario,
} from './scenario';

export const modelPatchSchema = scenarioSchema
  .omit({
    schemaVersion: true,
    id: true,
    templateId: true,
    version: true,
    confirmed: true,
    sourcePrompt: true,
    guard: true,
    exit: true,
    failurePolicy: true,
    name: true,
    description: true,
  })
  .partial()
  .extend({ trigger: scenarioSchema.shape.trigger.partial().optional() });

export function modelContext(scenario: Scenario) {
  const { trigger, actions, timeoutSeconds, reminder } = scenario;
  return { trigger, actions, timeoutSeconds, ...(reminder ? { reminder } : {}) };
}

export function parseModelModification(
  value: unknown,
  prompt: string,
  base: Scenario,
): CompileResult {
  if (value && typeof value === 'object' && 'patch' in value) {
    const { patch } = z.object({ patch: modelPatchSchema }).strict().parse(value);
    return parseModelDraft(
      {
        ...base,
        ...patch,
        trigger: { ...base.trigger, ...patch.trigger },
      },
      prompt,
    );
  }
  const result = parseModelDraft(value, prompt);
  if (result.draft.templateId !== base.templateId || result.draft.id !== base.id)
    throw new CompileError(
      'provider_output',
      '模型修改了场景归属，已阻止加载。请明确修改要求后重试。',
      502,
    );
  if (result.draft.name !== base.name || result.draft.description !== base.description)
    throw new Error('参数修改不能改写场景名称或说明');
  return result;
}

export class CompileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
  }
}

export interface CompileResult {
  mode: 'demo' | 'model';
  draft: Scenario;
  assumptions: string[];
  message: string;
}

export function assumptionsFor(scenario: Scenario): string[] {
  const { signal, operator, threshold, holdSeconds } = scenario.trigger;
  return [
    '停车定义为 P 挡且车速为 0；任何动作前和状态回读前都会重新检查。',
    `${signalLabels[signal].label}${operator === 'gt' ? '高于' : '低于'} ${threshold} ${signalLabels[signal].unit}，连续 ${holdSeconds} 秒；中途恢复则重新计时。`,
    scenario.reminder
      ? `${reminderLabel(scenario.reminder)}。${scenario.reminder.kind === 'charge' ? '驶离或拔枪取消后续动作与提醒' : '驶离停止后续动作，主驾离座取消唤醒'}；进入流程后不因原触发阈值变化而取消。退出不回滚。`
      : '开始行驶或触发条件失效时只取消在途及后续动作，不恢复已改变的设备状态。',
    ...(scenario.actions.some((action) => action.capability === 'seat.recline')
      ? ['对应座位需明确有人，座椅请求与回读前都会检查占用。']
      : []),
    `用户手动操作优先；每个动作 ${scenario.timeoutSeconds} 秒超时，失败后仅继续不依赖该动作的任务。`,
  ];
}

export function compileDemo(prompt: string): CompileResult {
  const exact = Object.values(templates).find(
    (template) => template.sourcePrompt === prompt.trim(),
  );
  if (exact?.reminder) return demoDraft(exact.templateId, prompt);
  const intent = prompt
    .replace(/(?:不(?:要)?|无需)(?:恢复|还原|复原)(?:设备(?:状态)?)?/g, '')
    .replace(/(?:我)?开始(?:开车|行驶)就(?:结束休息模式|停止这个场景|结束场景)/g, '');
  if (/恢复|还原|复原/.test(intent))
    throw new CompileError(
      'unsupported_request',
      '当前退出策略只停止在途与后续动作，不支持自动恢复设备状态。请明确是否接受此退出策略。',
    );
  if (/不|别|无需|禁止|取消|停止|结束/.test(intent))
    throw new CompileError(
      'needs_clarification',
      '需求包含否定、取消或停止指令。本地模板不能可靠解释这些语义，未生成草案；请明确要保留的动作，或使用工作台的停止按钮。',
    );
  if (/车窗|天窗|座椅|车门|后视镜|油门|刹车|制动|导航|雨刷|自动驾驶/.test(prompt))
    throw new CompileError(
      'unsupported_request',
      '需求包含当前能力目录之外的操作。这里只支持停车时的空调、媒体和阅读灯，请移除未支持的部分后重试。',
    );
  if (/行驶时|开车时|驾驶时|D\s*挡时/.test(prompt))
    throw new CompileError(
      'unsupported_request',
      '当前原型只支持停车场景。请明确 P 挡且车速为 0 时的需求；开始行驶会结束场景。',
    );
  if (/阅读|看书|灯/.test(prompt) && /休息|降温|太热|空调|空气|外循环/.test(prompt))
    throw new CompileError(
      'needs_clarification',
      '需求涉及多个模板。本地模式不能合并这些动作，请明确选择休息、阅读或清新座舱中的一个场景。',
    );
  if (
    /\d/.test(prompt) ||
    (/[零〇一二三四五六七八九十百千万两半]+\s*(?:秒|分钟|小时|度|档|摄氏度)/.test(prompt) &&
      !Object.values(templates).some((template) => template.sourcePrompt === prompt.trim()))
  )
    throw new CompileError(
      'needs_clarification',
      '本地模板创建不提取自定义数值。请先选择示例，再切到“修改当前场景”，例如“把持续时间改为 8 秒”；也可以直接编辑参数。',
    );
  const id = /暖舱|预热|偏冷|太冷/.test(prompt)
    ? 'warmup'
    : /强力降温|快速降温|闷热/.test(prompt)
      ? 'cooldown'
      : /夜间放松|夜间休息|白噪音/.test(prompt)
        ? 'night'
        : /阅读|看书|灯/.test(prompt)
          ? 'reading'
          : /空气|二氧化碳|外循环|清新/.test(prompt)
            ? 'refresh'
            : /休息|休憩|降温|太热|空调|音乐/.test(prompt)
              ? 'rest'
              : null;
  if (!id)
    throw new CompileError(
      'needs_clarification',
      '暂时无法匹配需求。请明确选择停车休息、阅读或空气清新场景；本地模式不会把未知需求替换成可执行模板。',
    );
  return demoDraft(id, prompt);
}

function demoDraft(id: Scenario['templateId'], prompt: string): CompileResult {
  const draft = cloneTemplate(id);
  draft.confirmed = false;
  draft.sourcePrompt = prompt;
  return {
    mode: 'demo',
    draft,
    assumptions: assumptionsFor(draft),
    message:
      '本地模板建议：根据关键词选择示例，不理解任意指令，也不会提取自定义数值。请核对并调整下方完整参数后确认。',
  };
}

// 本地只接受完整匹配的参数修改句式；任何未解析部分都会使整次修改失败。
export function modifyDemo(prompt: string, base: Scenario): CompileResult {
  const draft = structuredClone(base);
  const fields = [
    { key: 'hold', names: '持续时间|等待时间', unit: '秒' },
    {
      key: 'threshold',
      names: '触发阈值',
      unit:
        signalLabels[base.trigger.signal].unit === '°C'
          ? '°C|℃|度'
          : signalLabels[base.trigger.signal].unit,
    },
    { key: 'climate.temperature', names: '目标温度|空调目标温度', unit: '°C|℃|度' },
    { key: 'media.volume', names: '音量|媒体音量', unit: '%|％' },
    { key: 'climate.fan', names: '风量|风量档位', unit: '档' },
    { key: 'ambient.light', names: '亮度|阅读灯亮度', unit: '%|％' },
    { key: 'wake', names: '唤醒时间|午休时长', unit: '秒' },
    { key: 'charge', names: '提醒电量|充电提醒阈值', unit: '%|％' },
    { key: 'seat.recline', names: '座椅后仰角度', unit: '°|度' },
  ];
  const changed = new Set<string>();
  const clauses = prompt
    .trim()
    .replace(/[。.!！]+$/, '')
    .split(/[，,；;\n]+/);
  for (const clause of clauses) {
    let matched = false;
    for (const field of fields) {
      const match = clause
        .trim()
        .match(
          new RegExp(
            `^(?:请)?(?:把|将)?\\s*(?:${field.names})\\s*(?:改为|改成|设为|调整为|调到)\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:${field.unit})$`,
            'i',
          ),
        );
      if (!match) continue;
      if (changed.has(field.key))
        throw new CompileError(
          'ambiguous_edit',
          '同一参数出现了多次修改。请为每个参数保留一个明确值。',
        );
      changed.add(field.key);
      const value = Number(match[1]);
      if (field.key === 'hold') draft.trigger.holdSeconds = value;
      else if (field.key === 'threshold') draft.trigger.threshold = value;
      else if (field.key === 'wake' && draft.reminder?.kind === 'wake')
        draft.reminder.afterSeconds = value;
      else if (field.key === 'charge' && draft.reminder?.kind === 'charge')
        draft.reminder.atPercent = value;
      else {
        const action = draft.actions.find((a) => a.capability === field.key);
        if (!action)
          throw new CompileError(
            'unsupported_edit',
            '当前场景没有这项动作。本地修改只能调整已有动作的参数，请使用对应场景模板。',
          );
        action.value = value;
      }
      matched = true;
      break;
    }
    if (!matched)
      throw new CompileError(
        'needs_clarification',
        '修改没有完整匹配，未应用任何部分。请使用明确参数和单位，例如“把持续时间改为 8 秒，目标温度设为 24°C”。不支持模糊数值、增删动作或修改退出策略。',
      );
  }
  draft.confirmed = false;
  draft.sourcePrompt = prompt;
  const validated = validateScenario(draft);
  if (!validated.scenario)
    throw new CompileError(
      'invalid_edit',
      '参数超出允许范围或不是有效整数。持续时间为 0–60 秒，目标温度为 16–30°C，音量为 0–60%，风量为 1–5 档，亮度为 0–100%；触发阈值须位于当前传感器范围。',
    );
  return {
    mode: 'demo',
    draft: validated.scenario,
    assumptions: assumptionsFor(validated.scenario),
    message: `本地规则解析：基于 v${base.version} 修改 ${changed.size} 个参数，未调用实时 AI。其余参数和退出策略保留；请核对差异并确认。`,
  };
}

export function parseModelDraft(value: unknown, prompt: string): CompileResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('模型输出必须是场景对象');
  const validated = validateScenario({
    ...value,
    confirmed: false,
    version: 1,
    sourcePrompt: prompt,
  });
  if (!validated.scenario) throw new Error(`模型场景校验失败：${validated.errors.join('；')}`);
  return {
    mode: 'model',
    draft: validated.scenario,
    assumptions: assumptionsFor(validated.scenario),
    message: '模型已生成候选场景。所有参数和退出策略都需要你确认后才能运行。',
  };
}
