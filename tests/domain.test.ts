import test from 'node:test';
import assert from 'node:assert/strict';
import { CabinRuntime, initialVehicle, replayEvidence } from '../src/domain/runtime';
import { cloneTemplate } from '../src/domain/templates';
import { validateScenario, type Scenario, type TemplateId } from '../src/domain/scenario';
import { verifyScenario } from '../src/domain/verification';
import { compileDemo, parseModelDraft } from '../src/domain/compiler';

for (const templateId of ['rest', 'reading', 'refresh'] as TemplateId[]) {
  const report = verifyScenario(cloneTemplate(templateId));
  for (const result of report.cases) {
    test(`${templateId}: ${result.name}`, () => assert.equal(result.passed, true, result.detail));
  }
}

test('零持续时间变更会被独立抖动与时间边界用例发现', () => {
  const changed = cloneTemplate('rest');
  changed.trigger.holdSeconds = 0;
  changed.version = 2;
  const result = verifyScenario(changed);
  assert.equal(result.cases.find((c) => c.id === 'jitter')?.passed, false);
  assert.equal(result.cases.find((c) => c.id === 'duration')?.passed, false);
  assert.equal(result.contractVersion, '1.0');
  assert.equal(cloneTemplate('rest').trigger.holdSeconds, 10);
});
test('运行冻结场景版本，不受外部修改影响', () => {
  const scene = cloneTemplate('rest');
  const runtime = new CabinRuntime(scene);
  scene.trigger.holdSeconds = 0;
  scene.version = 5;
  scene.actions.length = 0;
  assert.equal(runtime.snapshot().scenario.version, 1);
  assert.equal(runtime.step(9).events.filter((e) => e.kind === 'accepted').length, 0);
  assert.equal(runtime.step(20).vehicle.targetTemperature, 24);
});
test('温控服务超时会继续媒体，保持原设定值', () => {
  const runtime = new CabinRuntime(cloneTemplate('rest'), initialVehicle, 'climate.temperature');
  const result = runtime.step(40);
  assert.equal(result.status, 'partial');
  assert.equal(result.vehicle.targetTemperature, 26);
  assert.equal(result.vehicle.playing, true);
  assert.equal(result.vehicle.volume, 20);
  const accepted = result.events.find(
    (e) => e.kind === 'accepted' && e.capability === 'climate.temperature',
  )!;
  const timeout = result.events.find((e) => e.kind === 'timeout')!;
  assert.equal(timeout.time - accepted.time, 3);
});
test('故障恢复后新运行可以完成，旧故障不污染新实例', () => {
  const scene = cloneTemplate('rest');
  assert.equal(
    new CabinRuntime(scene, initialVehicle, 'climate.temperature').step(40).status,
    'partial',
  );
  assert.equal(new CabinRuntime(scene).step(40).status, 'completed');
});
test('手动改温取消正在等待回读的温控请求', () => {
  const runtime = new CabinRuntime(cloneTemplate('rest'));
  runtime.step(11);
  assert.equal(runtime.snapshot().pending, 'climate.temperature');
  runtime.manual({ capability: 'climate.temperature', value: 27 });
  const result = runtime.step(40);
  assert.equal(result.vehicle.targetTemperature, 27);
  assert.equal(result.vehicle.playing, true);
  assert.equal(result.status, 'partial');
});
test('触发前接管温控，后续自动化不抢回温控设备', () => {
  const runtime = new CabinRuntime(cloneTemplate('rest'));
  runtime.manual({ capability: 'climate.temperature', value: 27 });
  const result = runtime.step(40);
  assert.equal(result.vehicle.targetTemperature, 27);
  assert.equal(result.vehicle.climatePower, false);
  assert.equal(result.vehicle.playing, true);
});
test('暂停通过不推进虚拟时钟实现，读取状态没有副作用', () => {
  const runtime = new CabinRuntime(cloneTemplate('rest'));
  runtime.step(4);
  assert.deepEqual(runtime.snapshot(), runtime.snapshot());
  assert.equal(runtime.snapshot().time, 4);
});
test('重复停止是幂等的；终态不会再次推进', () => {
  const runtime = new CabinRuntime(cloneTemplate('rest'));
  runtime.step(10);
  runtime.cancel();
  const evidence = runtime.snapshot();
  runtime.cancel();
  runtime.step(50);
  assert.deepEqual(runtime.snapshot(), evidence);
});
test('手动、信号、停止输入可按原时间重放', () => {
  const runtime = new CabinRuntime(cloneTemplate('rest'));
  runtime.step(11);
  runtime.manual({ capability: 'climate.temperature', value: 27 });
  runtime.setSignals({ temperature: 32 });
  runtime.cancel();
  const evidence = runtime.snapshot();
  const replay = replayEvidence(evidence).snapshot();
  assert.deepEqual(replay.events, evidence.events);
  assert.deepEqual(replay.commands, evidence.commands);
  assert.deepEqual(replay.vehicle, evidence.vehicle);
});
test('非法能力和参数被边界校验拦截', () => {
  const template = cloneTemplate('rest');
  for (const actions of [
    [{ capability: 'climate.temperature', value: 100 }],
    [{ capability: 'shell.exec', value: 'echo' }],
    [{ capability: 'media.volume', value: -5 }],
  ]) {
    assert.equal(validateScenario({ ...template, actions }).scenario, undefined);
  }
});
test('缺失电源依赖、重复能力和矛盾媒体动作被拦截', () => {
  const scene = cloneTemplate('rest');
  assert.equal(
    validateScenario({ ...scene, actions: [{ capability: 'climate.temperature', value: 24 }] })
      .scenario,
    undefined,
  );
  assert.equal(
    validateScenario({ ...scene, actions: [...scene.actions, scene.actions[0]] }).scenario,
    undefined,
  );
  assert.equal(
    validateScenario({
      ...scene,
      actions: [...scene.actions, { capability: 'media.pause', value: true }],
    }).scenario,
    undefined,
  );
});
test('超范围信号、非法字段和非有限值被拦截', () => {
  const runtime = new CabinRuntime(cloneTemplate('rest'));
  assert.throws(() => runtime.setSignals({ temperature: NaN }));
  assert.throws(() => runtime.setSignals({ speed: -1 }));
  assert.throws(() => runtime.setSignals({ targetTemperature: 19 } as never));
  assert.throws(() => runtime.step(Infinity));
  assert.throws(() => runtime.manual({ capability: 'climate.temperature', value: 70 }));
});
test('DSL 拒绝代码、未知字段与隐式恢复策略', () => {
  const scene = cloneTemplate('rest');
  assert.equal(validateScenario({ ...scene, code: 'console.log(1)' }).scenario, undefined);
  assert.equal(validateScenario({ ...scene, exit: 'restore-everything' }).scenario, undefined);
});
test('草案编译明确标注本地模板，不假装理解自定义阈值', () => {
  const result = compileDemo('超过 35 度时停车休息', 'rest');
  assert.equal(result.mode, 'demo');
  assert.equal(result.draft.confirmed, false);
  assert.equal(result.draft.trigger.threshold, 28);
  assert.match(result.message, /不会提取自定义数值/);
  assert.throws(() => new CabinRuntime(result.draft));
});
test('本地建议选择正确的模板，未知需求仍需人工核对', () => {
  assert.equal(compileDemo('停车看书，打开阅读灯', 'rest').draft.templateId, 'reading');
  assert.equal(compileDemo('空气闷，开外循环', 'rest').draft.templateId, 'refresh');
  assert.equal(compileDemo('这是未支持的新需求', 'reading').draft.templateId, 'reading');
});
test('模型无法绕过确认或篡改原始用户输入', () => {
  const value = { ...cloneTemplate('rest'), confirmed: true, version: 7, sourcePrompt: 'injected' };
  const result = parseModelDraft(value, '停车休息太热就降温');
  assert.equal(result.draft.confirmed, false);
  assert.equal(result.draft.version, 1);
  assert.equal(result.draft.sourcePrompt, '停车休息太热就降温');
});
test('模型非法输出不会进入执行器', () => {
  for (const value of [
    null,
    [],
    'code',
    {},
    { ...cloneTemplate('rest'), actions: [{ capability: 'vehicle.drive', value: true }] },
  ])
    assert.throws(() => parseModelDraft(value, '停车休息'));
});
test('未确认版本不能通过运行验证伪造成功', () => {
  const scene: Scenario = { ...cloneTemplate('rest'), confirmed: false };
  const report = verifyScenario(scene);
  assert.ok(report.passed < report.total);
  assert.equal(report.cases.find((c) => c.id === 'normal')?.passed, false);
});
