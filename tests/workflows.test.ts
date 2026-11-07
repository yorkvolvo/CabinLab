import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDemo, modifyDemo } from '../src/domain/compiler';
import { cloneTemplate } from '../src/domain/templates';
import { scenarioChanges, compareVersions } from '../src/domain/comparison';
import { CabinRuntime, initialVehicle } from '../src/domain/runtime';
import { inspectEvidence } from '../src/domain/evidence';

test('明确参数修改保留未提及字段，基准不变且草案需要确认', () => {
  const base = cloneTemplate('rest');
  base.version = 7;
  const original = structuredClone(base);
  const { draft, message } = modifyDemo(
    '把持续时间改为 8 秒，目标温度设为 22°C，音量调到 15%。',
    base,
  );
  assert.deepEqual(base, original);
  assert.equal(draft.trigger.holdSeconds, 8);
  assert.equal(draft.actions.find((a) => a.capability === 'climate.temperature')?.value, 22);
  assert.equal(draft.actions.find((a) => a.capability === 'media.volume')?.value, 15);
  assert.equal(draft.exit, base.exit);
  assert.equal(draft.trigger.threshold, base.trigger.threshold);
  assert.equal(draft.confirmed, false);
  assert.match(message, /v7.*3 个参数/);
});

for (const prompt of [
  '把持续时间改为 5 秒，打开车窗',
  '把持续时间改为 5 秒，',
  '把持续时间改为 5 秒，持续时间改为 8 秒',
  '温度低一点',
  '持续时间设为十秒',
  '持续时间改为 5',
  '退出时恢复空调',
])
  test(`模糊或混合指令整次拒绝：${prompt}`, () => {
    const base = cloneTemplate('rest');
    assert.throws(() => modifyDemo(prompt, base));
    assert.deepEqual(base, cloneTemplate('rest'));
  });

for (const prompt of [
  '持续时间改为 -1 秒',
  '持续时间改为 61 秒',
  '持续时间改为 1.5 秒',
  '目标温度设为 40°C',
  '音量设为 61%',
  '触发阈值设为 100°C',
])
  test(`数值约束拒绝：${prompt}`, () =>
    assert.throws(() => modifyDemo(prompt, cloneTemplate('rest')), /范围/));

test('不同场景使用对应单位，只能修改已有动作', () => {
  assert.equal(
    modifyDemo('触发阈值改为 1200 ppm，风量设为 4 档', cloneTemplate('refresh')).draft.trigger
      .threshold,
    1200,
  );
  assert.equal(
    modifyDemo('阅读灯亮度设为 70%，触发阈值改为 80 lx', cloneTemplate('reading')).draft.actions[0]
      .value,
    70,
  );
  assert.throws(() => modifyDemo('触发阈值改为 28°C', cloneTemplate('refresh')), /没有完整匹配/);
  assert.throws(() => modifyDemo('目标温度改为 24°C', cloneTemplate('reading')), /没有这项动作/);
});
test('已知未支持能力不能混入本地创建结果', () => {
  assert.throws(() => compileDemo('停车休息时开空调并打开车窗'), /能力目录之外/);
});
test('行驶中执行、隐式恢复和跨模板混合需求需重新明确', () => {
  for (const prompt of ['开车时太热就开空调', '停车休息，退出时恢复空调', '停车阅读时太热开空调'])
    assert.throws(() => compileDemo(prompt));
  assert.equal(compileDemo('停车休息开空调，不要恢复设备').draft.exit, 'cancel-pending-no-restore');
});
test('版本差异包含动作值和执行顺序，不把版本号视作行为变化', () => {
  const before = cloneTemplate('rest');
  const after = structuredClone(before);
  after.version = 2;
  assert.equal(scenarioChanges(before, after).length, 0);
  after.trigger.holdSeconds = 0;
  [after.actions[2], after.actions[3]] = [after.actions[3], after.actions[2]];
  assert.deepEqual(
    scenarioChanges(before, after).map((c) => c.field),
    ['持续时间', '第 3 个动作', '第 4 个动作'],
  );
});
test('版本对照用固定预期暴露零秒变更的 8 项回归，反向对照显示恢复', () => {
  const before = cloneTemplate('rest');
  const after = { ...before, version: 2, trigger: { ...before.trigger, holdSeconds: 0 } };
  const comparison = compareVersions(before, after);
  assert.equal(comparison.previous.passed, 22);
  assert.equal(comparison.current.passed, 14);
  assert.equal(comparison.regressions, 8);
  assert.equal(comparison.recoveries, 0);
  assert.equal(comparison.transitions.find((t) => t.id === 'jitter')?.change, 'regression');
  assert.equal(compareVersions(after, before).recoveries, 8);
  assert.deepEqual(after.trigger.holdSeconds, 0);
});
test('未确认版本或不同场景族不能进行误导性的对照', () => {
  assert.throws(
    () => compareVersions(cloneTemplate('rest'), cloneTemplate('reading')),
    /同一场景族/,
  );
  assert.throws(
    () => compareVersions(cloneTemplate('rest'), { ...cloneTemplate('rest'), confirmed: false }),
    /已确认/,
  );
});

function evidence() {
  return new CabinRuntime(cloneTemplate('rest')).step(20);
}
test('导出 JSON 在新实例中重放，属性顺序不影响核验', () => {
  const source = evidence();
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  const result = inspectEvidence(JSON.stringify(reordered));
  assert.deepEqual(result.source.events, result.replayed.events);
  assert.deepEqual(result.source.vehicle, result.replayed.vehicle);
});
test('完整实验核对场景归属，导入不采用文件内的验证答案', () => {
  const run = evidence();
  const bundle = {
    format: 'cabinlab.experiment',
    schemaVersion: 1,
    scenario: run.scenario,
    run,
    verification: { passed: 999 },
  };
  assert.equal(inspectEvidence(JSON.stringify(bundle)).source.status, 'completed');
  bundle.scenario = { ...run.scenario, version: 2 };
  assert.throws(() => inspectEvidence(JSON.stringify(bundle)), /场景不一致/);
  assert.throws(() => inspectEvidence(JSON.stringify({ ...bundle, run: null })), /尚无运行/);
});
test('手动接管、信号输入、停止和部分失败都能独立复现', () => {
  for (const fault of ['none', 'climate.temperature'] as const) {
    const r = new CabinRuntime(cloneTemplate('rest'), initialVehicle, fault);
    r.step(11);
    if (fault === 'none') {
      r.manual({ capability: 'climate.temperature', value: 27 });
      r.cancel();
    } else r.step(30);
    const result = inspectEvidence(JSON.stringify(r.snapshot()));
    assert.deepEqual(result.source.commands, result.replayed.commands);
    assert.equal(result.source.status, fault === 'none' ? 'cancelled' : 'partial');
  }
});
test('等待超过 600 秒的证据分段推进，仍可复现后续触发', () => {
  const r = new CabinRuntime(cloneTemplate('rest'), { ...initialVehicle, temperature: 20 });
  r.step(600);
  r.step(30);
  r.setSignals({ temperature: 30 });
  r.step(20);
  assert.equal(inspectEvidence(JSON.stringify(r.snapshot())).replayed.time, 644);
});

for (const field of [
  'event',
  'vehicle',
  'status',
  'time',
  'commands',
  'progress',
  'locked',
] as const)
  test(`修改后的 ${field} 记录不会被当作可复现证据`, () => {
    const run = evidence();
    if (field === 'event') run.events[0].detail = '伪造已成功';
    if (field === 'vehicle') run.vehicle.targetTemperature = 23;
    if (field === 'status') run.status = 'partial';
    if (field === 'time') run.time++;
    if (field === 'commands') run.commands.push({ time: 0, type: 'cancel' });
    if (field === 'progress') run.progress = 0;
    if (field === 'locked') run.locked = ['climate'];
    assert.throws(() => inspectEvidence(JSON.stringify(run)), /不一致/);
  });
test('事件顺序、倒序命令、超范围时钟及未知能力被结构校验拒绝', () => {
  const run = evidence();
  run.events[0].index = 1;
  assert.throws(() => inspectEvidence(JSON.stringify(run)), /顺序/);
  assert.throws(
    () =>
      inspectEvidence(
        JSON.stringify({
          ...evidence(),
          commands: [
            { time: 3, type: 'signals', patch: {} },
            { time: 2, type: 'cancel' },
          ],
        }),
      ),
    /时间不连续/,
  );
  assert.throws(() => inspectEvidence(JSON.stringify({ ...evidence(), time: 3601 })), /结构或参数/);
  assert.throws(
    () => inspectEvidence(JSON.stringify({ ...evidence(), fault: 'vehicle.drive' })),
    /结构或参数/,
  );
});
test('旧运行时、未知字段、损坏 JSON 和超限文件有明确错误', () => {
  assert.throws(
    () => inspectEvidence(JSON.stringify({ ...evidence(), runtimeVersion: undefined })),
    /运行时版本/,
  );
  assert.throws(
    () => inspectEvidence(JSON.stringify({ ...evidence(), runtimeVersion: 'future' })),
    /运行时版本/,
  );
  assert.throws(
    () => inspectEvidence(JSON.stringify({ ...evidence(), code: 'not executed' })),
    /结构或参数/,
  );
  assert.throws(() => inspectEvidence('{'), /合法 JSON/);
  assert.throws(() => inspectEvidence('x'.repeat(1024 * 1024 + 1)), /1 MB/);
  assert.throws(
    () =>
      inspectEvidence(
        JSON.stringify({
          ...evidence(),
          commands: Array.from({ length: 1001 }, () => ({ time: 0, type: 'cancel' })),
        }),
      ),
    /结构或参数/,
  );
});
