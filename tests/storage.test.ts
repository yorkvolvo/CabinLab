import test from 'node:test';
import assert from 'node:assert/strict';
import { readVersions } from '../src/storage';
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

test('六个场景族可保存超过旧版 90 条的历史，未确认与非法场景仍不加载', () => {
  const saved = Object.values(templates).flatMap((template) =>
    Array.from({ length: 20 }, (_, index) => ({ ...template, version: index + 1 })),
  );
  withStoredVersions(saved, () => assert.equal(readVersions().length, 120));
  withStoredVersions([{ ...cloneTemplate('rest'), confirmed: false }, { id: 'invalid' }], () => {
    assert.deepEqual(readVersions(), Object.values(templates));
  });
});
