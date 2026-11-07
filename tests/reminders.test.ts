import test from 'node:test';
import assert from 'node:assert/strict';
import { CabinRuntime, previewVehicle } from '../src/domain/runtime';
import { cloneTemplate } from '../src/domain/templates';
import { parseModelModification, modifyDemo } from '../src/domain/compiler';
import { inspectEvidence } from '../src/domain/evidence';
import { scenarioChanges } from '../src/domain/comparison';

const nap = () => cloneTemplate('nap');
const charge = () => cloneTemplate('charging');

test('等候时环境恢复不清除午休唤醒，跳到边界只提醒一次且可重放', () => {
  const scene = nap();
  const runtime = new CabinRuntime(scene, {
    ...previewVehicle(scene),
    driverRecline: 7,
    playing: true,
    track: '轻音乐',
  });
  const waiting = runtime.step(6);
  assert.equal(waiting.reminderDueAt, 1206);
  assert.equal(inspectEvidence(JSON.stringify(waiting)).replayed.status, 'waiting');
  runtime.setSignals({ temperature: 24 });
  assert.equal(runtime.advanceTo(1205).status, 'waiting');
  const complete = runtime.step();
  assert.equal(complete.status, 'completed');
  assert.equal(complete.events.filter((event) => event.kind === 'reminder').length, 1);
  assert.equal(complete.vehicle.driverRecline, 7);
  assert.equal(complete.vehicle.playing, true);
  assert.equal(complete.vehicle.track, '轻音乐');
  assert.equal(complete.reminderDueAt, undefined);
  assert.equal(inspectEvidence(JSON.stringify(complete)).replayed.time, 1206);
});

test('副驾动作只使用副驾占用，未知占用禁止手动后仰', () => {
  const scene = nap();
  scene.actions[0] = { capability: 'seat.recline', seat: 'passenger', value: 30 };
  const vehicle = previewVehicle(scene);
  const runtime = new CabinRuntime(scene, { ...vehicle, passengerOccupied: undefined });
  assert.throws(() => runtime.manual(scene.actions[0]), /对应座位有人/);
  const skipped = runtime.step(8);
  assert.equal(skipped.vehicle.passengerRecline, 0);
  assert.equal(skipped.vehicle.climatePower, true);
  const occupied = new CabinRuntime(scene, { ...vehicle, passengerOccupied: true }).step(6);
  assert.equal(occupied.vehicle.passengerRecline, 30);
  assert.equal(occupied.vehicle.driverRecline, 0);
});

test('准备动作期间跨过目标电量不丢提醒，拔枪则取消在途座椅', () => {
  const scene = charge();
  const runtime = new CabinRuntime(scene, previewVehicle(scene));
  runtime.setSignals({ batteryPercent: 81 });
  assert.equal(runtime.snapshot().status, 'executing');
  assert.equal(runtime.step(3).events.filter((event) => event.kind === 'reminder').length, 1);
  const unplugged = new CabinRuntime(scene, previewVehicle(scene));
  assert.equal(unplugged.snapshot().pending, 'seat.recline');
  unplugged.setSignals({ charging: false });
  assert.equal(unplugged.step(3).vehicle.driverRecline, 0);
  assert.equal(unplugged.snapshot().status, 'stopped');
});

test('提醒可独立修改，预演前仍须确认，差异显示实际提醒值', () => {
  const base = charge();
  const model = parseModelModification(
    { patch: { reminder: { kind: 'charge', atPercent: 85 } } },
    '提醒电量改为85%',
    base,
  );
  assert.deepEqual(model.draft.reminder, { kind: 'charge', atPercent: 85 });
  assert.deepEqual(model.draft.actions, base.actions);
  assert.throws(() => new CabinRuntime(model.draft), /先确认/);
  assert.ok(
    scenarioChanges(base, model.draft).some(
      (change) => change.field === '提醒' && change.after.includes('85%'),
    ),
  );
  assert.deepEqual(modifyDemo('唤醒时间改为 300 秒', nap()).draft.reminder, {
    kind: 'wake',
    afterSeconds: 300,
  });
  assert.throws(() =>
    parseModelModification(
      { patch: { reminder: { kind: 'charge', atPercent: 101 } } },
      '提醒电量改为101%',
      base,
    ),
  );
});

test('提醒证据不得伪称旧运行时，也不能篡改等待期限', () => {
  const scene = nap();
  const waiting = new CabinRuntime(scene, previewVehicle(scene)).step(6);
  assert.throws(
    () => inspectEvidence(JSON.stringify({ ...waiting, runtimeVersion: '1.1.0' })),
    /无法.*重放/,
  );
  assert.throws(
    () => inspectEvidence(JSON.stringify({ ...waiting, reminderDueAt: 1000 })),
    /不一致/,
  );
  const legacy = new CabinRuntime(cloneTemplate('rest'), undefined, 'none', 'legacy', '1.1.0').step(
    20,
  );
  assert.equal(inspectEvidence(JSON.stringify(legacy)).replayed.status, 'completed');
});

test('拔枪恢复座椅并保留手动接管的空调，离座或驶离时跳过不安全的恢复', () => {
  const scene = charge();
  const initial = { ...previewVehicle(scene), driverRecline: 8 };
  const parked = new CabinRuntime(scene, initial);
  parked.step(3);
  parked.manual({ capability: 'climate.temperature', value: 23 });
  const unplugged = parked.setSignals({ charging: false });
  assert.equal(unplugged.vehicle.driverRecline, 8);
  assert.equal(unplugged.vehicle.targetTemperature, 23);
  assert.equal(unplugged.vehicle.climatePower, true);
  assert.equal(inspectEvidence(JSON.stringify(unplugged)).replayed.status, 'stopped');

  for (const signals of [{ driverOccupied: false, charging: false }, { gear: 'D' }] as const) {
    const running = new CabinRuntime(scene, initial);
    running.step(3);
    const stopped = running.setSignals(signals);
    assert.equal(stopped.vehicle.driverRecline, 20);
    assert.ok(
      stopped.events.some(
        (event) => event.kind === 'restore-skipped' && event.capability === 'seat.recline',
      ),
    );
  }
});

test('空调回读未知时不恢复该设备，停车手动停止时其他设置仍恢复', () => {
  const scene = nap();
  const runtime = new CabinRuntime(
    scene,
    previewVehicle(scene),
    'climate.temperature:feedback-lost',
  );
  runtime.step(10);
  const cancelled = runtime.cancel();
  assert.equal(cancelled.vehicle.climatePower, true);
  assert.equal(cancelled.vehicle.driverRecline, 0);
  assert.equal(cancelled.vehicle.playing, false);
  assert.ok(
    cancelled.events.some(
      (event) => event.kind === 'restore-skipped' && event.detail.includes('设备结果未知'),
    ),
  );
});

test('雨天关窗按结果发出一次提醒，回读丢失时保留未知', () => {
  for (const family of ['rainClose', 'rainLink'] as const) {
    const scene = cloneTemplate(family);
    const initial = previewVehicle(scene);
    const failed = new CabinRuntime(scene, initial, 'window.close:feedback-lost').step(20);
    const notices = failed.events.filter((event) => event.kind === 'reminder');
    assert.equal(failed.status, 'uncertain');
    assert.equal(notices.length, 1);
    assert.match(notices[0].detail, /雨天关窗.*结果未知/);
    assert.equal(inspectEvidence(JSON.stringify(failed)).replayed.status, 'uncertain');
  }
});
