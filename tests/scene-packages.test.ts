import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../server/app';
import { CabinRuntime, previewVehicle } from '../src/domain/runtime';
import { packageNapPreview, parseScenePackage, voiceNapMinutes } from '../src/domain/scene-package';
import { cloneTemplate } from '../src/domain/templates';

function previewNap(version: number, seconds = 600) {
  const scene = {
    ...cloneTemplate('nap'),
    version,
    reminder: { kind: 'wake' as const, afterSeconds: seconds },
  };
  const runtime = new CabinRuntime(scene, previewVehicle(scene));
  return { waiting: runtime.step(6), completed: runtime.advanceTo(6 + seconds) };
}

test('只有通过唤醒和恢复复核的已确认午休可以生成场景包', () => {
  const { waiting, completed } = previewNap(3);
  assert.throws(() => packageNapPreview(JSON.stringify(waiting)), /完成唤醒及设置恢复/);
  assert.throws(
    () =>
      packageNapPreview(
        JSON.stringify({ ...completed, vehicle: { ...completed.vehicle, driverRecline: 25 } }),
      ),
    /重放与记录不一致/,
  );
  const pack = packageNapPreview(JSON.stringify(completed));
  assert.equal(pack.version, 3);
  assert.deepEqual(pack.scenario, completed.scenario);
  assert.throws(() => parseScenePackage({ ...pack, version: 4 }), /场景包无效/);
});

test('模拟语音只允许启动午休，时长限定 1–30 分钟', () => {
  assert.equal(voiceNapMinutes('开始午休'), undefined);
  assert.equal(voiceNapMinutes('启动定时午休 15 分钟。'), 15);
  assert.throws(() => voiceNapMinutes('开始午休 31 分钟'), /1–30/);
  assert.throws(() => voiceNapMinutes('开始午休然后开窗'), /试试/);
});

test('发布与车端安装分离，已发布版本不可覆写', async (t) => {
  const server = createApp({ provider: 'demo' }).listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = (path: string, body: unknown) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const getInstalled = async () =>
    (await (await fetch(url + '/vehicle/scene-package')).json()).scenePackage;
  assert.equal(await getInstalled(), null);
  const { waiting, completed } = previewNap(3);
  assert.equal((await post('/scene-packages/3/deliver', {})).status, 404);
  assert.equal((await post('/scene-packages', waiting)).status, 422);
  const response = await post('/scene-packages', completed);
  assert.equal(response.status, 201);
  const pack = parseScenePackage(await response.json());
  assert.equal(await getInstalled(), null);
  assert.equal((await post('/scene-packages', previewNap(3, 720).completed)).status, 409);
  assert.equal((await post('/scene-packages', completed)).status, 200);
  assert.equal((await post('/scene-packages/3/deliver', {})).status, 200);
  assert.deepEqual(await getInstalled(), pack);
});
