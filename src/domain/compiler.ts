import { cloneTemplate } from './templates';
import { signalLabels, validateScenario, type Scenario, type TemplateId } from './scenario';

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
    '开始行驶或触发条件失效时只取消在途及后续动作，不恢复已改变的空调、媒体或灯光。',
    `用户手动操作优先；每个动作 ${scenario.timeoutSeconds} 秒超时，失败后仅继续不依赖该动作的任务。`,
  ];
}

export function compileDemo(prompt: string, selected: TemplateId): CompileResult {
  const id = /阅读|看书|灯/.test(prompt)
    ? 'reading'
    : /空气|二氧化碳|外循环|清新/.test(prompt)
      ? 'refresh'
      : /休息|休憩|降温|太热|空调|音乐/.test(prompt)
        ? 'rest'
        : selected;
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
