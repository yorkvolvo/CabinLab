import { actionLabel, reminderLabel, signalLabels, type Scenario } from './scenario';
import { verifyScenario } from './verification';

export interface ScenarioChange {
  field: string;
  before: string;
  after: string;
}

export function scenarioChanges(before: Scenario, after: Scenario): ScenarioChange[] {
  const changes: ScenarioChange[] = [];
  const add = (field: string, previous: string | number, next: string | number) => {
    if (previous !== next) changes.push({ field, before: String(previous), after: String(next) });
  };
  add('场景名称', before.name, after.name);
  add('场景说明', before.description, after.description);
  add('需求原文', before.sourcePrompt, after.sourcePrompt);
  add(
    '触发信号',
    signalLabels[before.trigger.signal].label,
    signalLabels[after.trigger.signal].label,
  );
  add(
    '比较关系',
    before.trigger.operator === 'gt' ? '高于' : '低于',
    after.trigger.operator === 'gt' ? '高于' : '低于',
  );
  add(
    '触发阈值',
    `${before.trigger.threshold} ${signalLabels[before.trigger.signal].unit}`,
    `${after.trigger.threshold} ${signalLabels[after.trigger.signal].unit}`,
  );
  add('持续时间', `${before.trigger.holdSeconds} 秒`, `${after.trigger.holdSeconds} 秒`);
  add('动作超时', `${before.timeoutSeconds} 秒`, `${after.timeoutSeconds} 秒`);
  add('提醒', reminderLabel(before.reminder), reminderLabel(after.reminder));
  for (let index = 0; index < Math.max(before.actions.length, after.actions.length); index++)
    add(
      `第 ${index + 1} 个动作`,
      before.actions[index] ? actionLabel(before.actions[index]) : '无',
      after.actions[index] ? actionLabel(after.actions[index]) : '无',
    );
  return changes;
}

export function compareVersions(before: Scenario, after: Scenario) {
  if (before.templateId !== after.templateId) throw new Error('只能对照同一场景族的版本');
  if (!before.confirmed || !after.confirmed) throw new Error('版本对照需要两个已确认的场景');
  const previous = verifyScenario(before);
  const current = verifyScenario(after);
  const transitions = current.cases.map((item) => {
    const prior = previous.cases.find((c) => c.id === item.id)!;
    return {
      id: item.id,
      name: item.name,
      beforePassed: prior.passed,
      afterPassed: item.passed,
      beforeDetail: prior.detail,
      afterDetail: item.detail,
      change: prior.passed === item.passed ? 'unchanged' : prior.passed ? 'regression' : 'recovery',
    };
  });
  return {
    format: 'cabinlab.comparison',
    contractVersion: previous.contractVersion,
    baseline: previous.baseline,
    changes: scenarioChanges(before, after),
    previous,
    current,
    transitions,
    regressions: transitions.filter((t) => t.change === 'regression').length,
    recoveries: transitions.filter((t) => t.change === 'recovery').length,
  };
}

export type VersionComparisonResult = ReturnType<typeof compareVersions>;
