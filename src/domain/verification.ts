import {
  CabinRuntime,
  initialVehicle,
  replayEvidence,
  type RunSnapshot,
  type Vehicle,
} from './runtime';
import { cloneTemplate } from './templates';
import { resourceOf, validateScenario, type Action, type Scenario } from './scenario';

export interface VerificationCase {
  id: string;
  name: string;
  group: string;
  passed: boolean;
  detail: string;
  evidence?: RunSnapshot;
}
export interface VerificationReport {
  scenario: Scenario;
  contractVersion: '1.1';
  baseline: string;
  passed: number;
  total: number;
  cases: VerificationCase[];
}

const expect = (condition: unknown, detail: string) => {
  if (!condition) throw new Error(detail);
};
const count = (s: RunSnapshot, kind: string) => s.events.filter((e) => e.kind === kind).length;
const actionsMatch = (s: RunSnapshot, action: Action) => {
  const v = s.vehicle;
  switch (action.capability) {
    case 'climate.power':
      return v.climatePower === action.value;
    case 'climate.temperature':
      return v.targetTemperature === action.value;
    case 'climate.fan':
      return v.fan === action.value;
    case 'climate.recirculation':
      return v.recirculation === action.value;
    case 'media.play':
      return v.playing && v.track === action.value;
    case 'media.pause':
      return !v.playing;
    case 'media.volume':
      return v.volume === action.value;
    case 'ambient.light':
      return v.light === action.value;
  }
};

// 产品基线独立于被测版本；修改场景不会改写期望。
export function verifyScenario(scenario: Scenario): VerificationReport {
  const baseline = cloneTemplate(scenario.templateId);
  const hold = baseline.trigger.holdSeconds;
  const signal = baseline.trigger.signal;
  const inactive = baseline.trigger.threshold + (baseline.trigger.operator === 'gt' ? -2 : 2);
  const active = baseline.trigger.threshold + (baseline.trigger.operator === 'gt' ? 2 : -2);
  const initial: Vehicle = { ...initialVehicle, [signal]: active };
  const cases: VerificationCase[] = [];
  let latest: CabinRuntime | undefined;
  const create = (v = initial) => {
    latest = new CabinRuntime(scenario, v);
    return latest;
  };
  const evidence = () => latest?.snapshot();
  const test = (id: string, name: string, group: string, run: () => string) => {
    latest = undefined;
    try {
      const detail = run();
      cases.push({ id, name, group, passed: true, detail, evidence: evidence() });
    } catch (e) {
      cases.push({
        id,
        name,
        group,
        passed: false,
        detail: e instanceof Error ? e.message : '未知验证错误',
        evidence: evidence(),
      });
    }
  };

  test('normal', '持续满足后，所有目标状态达成', '正常路径', () => {
    const s = create().step(90);
    expect(s.status === 'completed', `预期全部完成，实际 ${s.status}`);
    expect(
      baseline.actions.every((a) => actionsMatch(s, a)),
      '设备状态与已确认产品基线不同',
    );
    return '全部动作回读值符合模板产品基线';
  });
  test('duration', `满 ${hold} 秒前不发出任何请求`, '触发边界', () => {
    const r = create();
    const s = r.step(hold - 1);
    expect(count(s, 'accepted') === 0, `未到 ${hold} 秒就出现动作请求，存在提前触发`);
    expect(count(r.step(), 'triggered') === 1, '到达约定持续时间后应触发一次');
    return '持续时间边界符合独立基线';
  });
  test('jitter', '短时信号波动不能误触发', '触发边界', () => {
    const r = create();
    r.step(1);
    r.setSignals({ [signal]: inactive });
    const s = r.step(30);
    expect(count(s, 'accepted') === 0, '短时波动已发出动作请求；建议恢复模板持续时间');
    return '1 秒波动后恢复，未产生动作请求';
  });
  test('equal', '等于阈值时不触发', '触发边界', () => {
    const s = create({ ...initial, [signal]: baseline.trigger.threshold }).step(90);
    expect(count(s, 'triggered') === 0, '等于阈值不应触发');
    return '严格大于 / 小于边界通过';
  });
  test('reset', '条件中断后重新计算持续时间', '触发边界', () => {
    const r = create();
    r.step(hold - 1);
    r.setSignals({ [signal]: inactive });
    r.step();
    r.setSignals({ [signal]: active });
    const s = r.step(hold - 1);
    expect(count(s, 'accepted') === 0, '计时未重置，或过早触发');
    expect(count(r.step(), 'triggered') === 1, '重新满足完整持续时间后未触发');
    return '不累加中断前时间';
  });
  test('gear', 'D 挡时阻止所有自动动作', '运行守卫', () => {
    const s = create({ ...initial, gear: 'D' }).step(60);
    expect(count(s, 'accepted') === 0, '非 P 挡仍发出了请求');
    return '非 P 挡，运行被停止';
  });
  test('speed', 'P 挡但车速非零仍要阻止', '运行守卫', () => {
    const s = create({ ...initial, speed: 1 }).step(60);
    expect(count(s, 'accepted') === 0, '车速非零仍发出了请求');
    return '挡位与速度同时参与守卫';
  });
  test('motion', '请求接受后，挡位变化取消在途动作', '运行守卫', () => {
    const r = create();
    const before = r.step(hold);
    expect(count(before, 'accepted') === 1, '在途请求前提未满足');
    r.setSignals({ gear: 'D' });
    const s = r.step(30);
    expect(count(s, 'confirmed') === 0 && s.status === 'stopped', '行驶后在途动作仍达成');
    return '接受不等于完成；状态回读前再次检查';
  });
  test('condition-loss', '执行期间触发条件失效则停止', '运行守卫', () => {
    const r = create();
    r.step(hold);
    r.setSignals({ [signal]: inactive });
    const s = r.step(30);
    expect(s.status === 'stopped' && count(s, 'confirmed') === 0, '条件失效后仍完成动作');
    return '在途与剩余动作已停止';
  });
  test('once', '持续满足也只运行一次', '执行语义', () => {
    const r = create();
    r.step(90);
    const s = r.step(90);
    expect(
      count(s, 'triggered') === 1 && count(s, 'accepted') === baseline.actions.length,
      '发生重复触发或动作数量不符',
    );
    return '单次会话不会重复执行';
  });
  test('accepted', '请求接受与状态达成分开记录', '执行语义', () => {
    const s = create().step(hold);
    expect(count(s, 'accepted') === 1 && count(s, 'confirmed') === 0, '请求与状态回读未分开');
    return '接受后需等待下一秒的状态回读';
  });
  test('cancel-armed', '触发前停止不产生动作', '停止与重放', () => {
    const r = create();
    r.cancel();
    const s = r.step(90);
    expect(s.status === 'cancelled' && count(s, 'accepted') === 0, '停止后仍有动作请求');
    return '等待中的运行可取消';
  });
  test('cancel-pending', '停止后在途请求不能再完成', '停止与重放', () => {
    const r = create();
    r.step(hold);
    r.cancel();
    const s = r.step(90);
    expect(count(s, 'confirmed') === 0 && s.status === 'cancelled', '取消后出现状态达成');
    return '在途请求被取消';
  });
  test('no-rollback', '退出保留已完成的设备状态', '停止与重放', () => {
    const r = create();
    r.step(hold + 1);
    const before = r.snapshot().vehicle;
    r.setSignals({ gear: 'D' });
    const s = r.step(30);
    expect(
      JSON.stringify({ ...s.vehicle, gear: 'P' }) === JSON.stringify(before),
      '退出时恢复了用户未要求恢复的状态',
    );
    return '只停止后续动作，无隐式回滚';
  });
  test('timeout', '服务超时不能报告全部成功', '异常与接管', () => {
    latest = new CabinRuntime(scenario, initial, baseline.actions[0].capability);
    const s = latest.step(90);
    expect(count(s, 'timeout') === 1 && s.status === 'partial', '超时没有产生部分完成状态');
    expect(
      !s.events.some(
        (e) => e.kind === 'confirmed' && e.capability === baseline.actions[0].capability,
      ),
      '超时动作被错误标记达成',
    );
    return '超时记录与状态回读明确区分';
  });
  test('independent', '故障后只继续独立动作', '异常与接管', () => {
    latest = new CabinRuntime(scenario, initial, baseline.actions[0].capability);
    const s = latest.step(90);
    const firstResource = resourceOf(baseline.actions[0].capability);
    const independent = baseline.actions.filter((a) => resourceOf(a.capability) !== firstResource);
    expect(count(s, 'timeout') === 1, '故障注入前提未满足');
    expect(
      independent.every((a) => actionsMatch(s, a)),
      '独立动作没有继续执行',
    );
    if (firstResource === 'climate')
      expect(
        !s.events.some((e) => e.kind === 'confirmed' && e.capability?.startsWith('climate.')),
        '空调开启失败后仍执行了依赖动作',
      );
    return '独立动作继续，依赖动作被阻止';
  });
  test('request-rejected', '请求拒绝不能冒充接受或达成', '异常与接管', () => {
    const capability = baseline.actions[0].capability;
    latest = new CabinRuntime(scenario, initial, `${capability}:rejected`);
    const s = latest.step(90);
    expect(count(s, 'rejected') === 1 && s.status === 'partial', '拒绝结果未正确记录');
    expect(
      !s.events.some(
        (event) =>
          event.capability === capability && ['accepted', 'confirmed'].includes(event.kind),
      ),
      '被拒绝的动作不应被标记为已接受或已达成',
    );
    return '拒绝与执行超时分开记录，不自动重试';
  });
  test('feedback-lost', '回读丢失标记未知并让出该设备', '异常与接管', () => {
    const capability = baseline.actions[0].capability;
    latest = new CabinRuntime(scenario, initial, `${capability}:feedback-lost`);
    const s = latest.step(90);
    const resource = resourceOf(capability);
    expect(count(s, 'unknown') === 1 && s.status === 'uncertain', '缺少未知结果终态');
    expect(
      s.events.filter(
        (event) => event.kind === 'accepted' && resourceOf(event.capability!) === resource,
      ).length === 1,
      '结果未知后重试或继续控制了同一设备',
    );
    expect(
      baseline.actions
        .filter((action) => resourceOf(action.capability) !== resource)
        .every((action) => actionsMatch(s, action)),
      '结果未知后未继续独立设备动作',
    );
    expect(
      !s.events.some((event) => event.kind === 'confirmed' && event.capability === capability),
      '丢失回读被误标为状态达成',
    );
    return '保留最后已知状态，不推断未执行；同一设备停止控制，独立动作继续';
  });
  test('manual', '手动操作取得设备控制权', '异常与接管', () => {
    const r = create();
    r.step(hold);
    const first = baseline.actions[0].capability;
    const manual: Action =
      resourceOf(first) === 'ambient'
        ? { capability: 'ambient.light', value: 25 }
        : { capability: 'climate.temperature', value: 27 };
    r.manual(manual);
    const s = r.step(90);
    expect(actionsMatch(s, manual), '自动化覆盖了用户手动设定');
    expect(s.locked.includes(resourceOf(first)), '设备未被标记为手动接管');
    return '在途动作取消，自动化不抢回该设备';
  });
  test('replay', '相同输入重放得到相同执行证据', '停止与重放', () => {
    const r = create();
    r.step(1);
    r.setSignals({ [signal]: inactive });
    r.step(1);
    r.setSignals({ [signal]: active });
    const s = r.step(90);
    const replay = replayEvidence(s).snapshot();
    expect(JSON.stringify(s.events) === JSON.stringify(replay.events), '重放事件不一致');
    expect(JSON.stringify(s.vehicle) === JSON.stringify(replay.vehicle), '重放终态不一致');
    return '初始状态、虚拟时钟与输入轨迹可复现';
  });
  test('whitelist', '未知能力不能进入执行器', '能力边界', () => {
    const invalid = validateScenario({
      ...scenario,
      actions: [{ capability: 'vehicle.drive', value: true }],
    });
    expect(!invalid.scenario, '未拦截不在目录中的能力');
    return '不生成或执行任意代码、驾驶控制';
  });
  test('confirmation', '未确认的候选场景禁止执行', '能力边界', () => {
    let rejected = false;
    try {
      new CabinRuntime({ ...scenario, confirmed: false });
    } catch {
      rejected = true;
    }
    expect(rejected, '未经确认的场景被执行');
    return '确认是执行前置条件';
  });
  return {
    scenario: structuredClone(scenario),
    contractVersion: '1.1',
    baseline: `${baseline.name} · 模板产品基线 v1（期望不会随场景修改）`,
    passed: cases.filter((c) => c.passed).length,
    total: cases.length,
    cases,
  };
}
