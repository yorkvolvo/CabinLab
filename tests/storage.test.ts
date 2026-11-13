import test from 'node:test';
import assert from 'node:assert/strict';
import { readVersions, saveVersion } from '../src/storage';
import { cloneTemplate, templates } from '../src/domain/templates';

function withStoredVersions(value: unknown, run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify(value) },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('增加场景族时保留用户旧版本，只补齐缺失模板', () => {
  const saved = { ...cloneTemplate('rest'), version: 7, name: '我保存的午休' };
  withStoredVersions([saved, cloneTemplate('reading'), cloneTemplate('refresh')], () => {
    const versions = readVersions();
    assert.deepEqual(
      versions.find((item) => item.templateId === 'rest'),
      saved,
    );
    assert.equal(versions.length, Object.keys(templates).length);
    assert.equal(versions.filter((item) => item.templateId === 'rest').length, 1);
    assert.equal(versions.filter((item) => item.templateId === 'warmup').length, 1);
  });
});

test('多个场景族可保存超过旧版 90 条的历史，未确认与非法场景仍不加载', () => {
  const saved = Object.values(templates).flatMap((template) =>
    Array.from({ length: 20 }, (_, index) => ({ ...template, version: index + 1 })),
  );
  withStoredVersions(saved, () => assert.equal(readVersions().length, saved.length));
  withStoredVersions([{ ...cloneTemplate('rest'), confirmed: false }, { id: 'invalid' }], () => {
    assert.deepEqual(readVersions(), Object.values(templates));
  });
});

test('只有原始午休模板追加恢复版，用户选择保留现状时仍加载原策略', () => {
  const old = {
    ...cloneTemplate('nap'),
    sourcePrompt:
      '定时午休：停车且车内温度高于 28°C 持续 2 秒，依次执行：主驾有人才把主驾座椅后仰到 25°；开启空调；设目标温度为 24°C；播放自然白噪音。准备动作完成后 20 分钟唤醒，离座或驶离取消。',
    exit: 'cancel-pending-no-restore',
  };
  withStoredVersions([old], () => {
    const versions = readVersions();
    assert.deepEqual(
      versions.filter((item) => item.templateId === 'nap'),
      [old, { ...cloneTemplate('nap'), version: 2 }],
    );
    withStoredVersions(versions, () => assert.deepEqual(readVersions(), versions));
  });
  const custom = { ...old, version: 2, sourcePrompt: '午休结束时保留设置' };
  withStoredVersions([old, custom], () =>
    assert.deepEqual(
      readVersions().filter((scene) => scene.templateId === 'nap'),
      [old, custom],
    ),
  );
});

test('存储写入失败时拒绝保存并提示导出，不抛原始异常', async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => '[]',
      setItem: () => {
        throw new Error('QuotaExceededError: storage full');
      },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: (_key: string, run: () => unknown) => run() } },
  });
  try {
    await assert.rejects(saveVersion(cloneTemplate('rest'), 1), /浏览器存储写入失败，版本未保存/);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
