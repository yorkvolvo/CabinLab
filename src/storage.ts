import { validateScenario, type Scenario } from './domain/scenario';
import { templates } from './domain/templates';

export const storageKey = 'cabinlab.scenarios.v1';
const legacyPrompts = {
  nap: '定时午休：停车且车内温度高于 28°C 持续 2 秒，依次执行：主驾有人才把主驾座椅后仰到 25°；开启空调；设目标温度为 24°C；播放自然白噪音。准备动作完成后 20 分钟唤醒，离座或驶离取消。',
  charging:
    '充电等候：停车并插枪充电，电量低于 100% 时立即启动（持续 0 秒）。依次执行：主驾有人才把主驾座椅后仰到 20°；开启空调；设目标温度为 24°C。电量达到 80% 提醒一次，拔枪或驶离取消。',
} as const;

function loadVersions(strict = false): Scenario[] {
  const stored = localStorage.getItem(storageKey);
  if (stored === null) return structuredClone(Object.values(templates));
  const raw: unknown = JSON.parse(stored);
  if (!Array.isArray(raw) || raw.length > Object.keys(templates).length * 30)
    throw new Error('本地版本数据格式无效，无法保存。');
  const valid = raw
    .map((s) => validateScenario(s).scenario)
    .filter((s): s is Scenario => Boolean(s?.confirmed));
  if (strict && valid.length !== raw.length) throw new Error('本地版本包含无效记录，无法保存。');
  for (const family of ['nap', 'charging'] as const) {
    const versions = valid.filter((scenario) => scenario.templateId === family);
    const legacy = validateScenario({
      ...templates[family],
      sourcePrompt: legacyPrompts[family],
      exit: 'cancel-pending-no-restore',
    }).scenario;
    if (versions.length === 1 && JSON.stringify(versions[0]) === JSON.stringify(legacy))
      valid.push({ ...templates[family], version: 2 });
  }
  return [
    ...valid,
    ...Object.values(templates).filter(
      (template) => !valid.some((scenario) => scenario.templateId === template.templateId),
    ),
  ];
}

export function readVersions(): Scenario[] {
  try {
    return loadVersions();
  } catch {
    return structuredClone(Object.values(templates));
  }
}

export function latestVersion(versions: Scenario[], family: Scenario['templateId']): number {
  return Math.max(
    0,
    ...versions.filter((scene) => scene.templateId === family).map((scene) => scene.version),
  );
}

export async function saveVersion(draft: Scenario, expectedVersion: number) {
  if (!navigator.locks) throw new Error('浏览器无法安全保存，请先导出场景。');
  return navigator.locks.request(storageKey, () => {
    const versions = loadVersions(true);
    const version = latestVersion(versions, draft.templateId);
    if (version !== expectedVersion)
      throw new Error('此场景已有更新的版本。草案仍在，请核对最新版本后重新编辑。');
    if (version >= 999) throw new Error('版本数已达到上限，请导出后整理本地数据。');
    const saved = { ...draft, id: draft.templateId, version: version + 1, confirmed: true };
    const merged = [
      ...versions.filter((scene) => scene.templateId !== draft.templateId),
      ...versions.filter((scene) => scene.templateId === draft.templateId).slice(-29),
      saved,
    ];
    localStorage.setItem(storageKey, JSON.stringify(merged));
    return saved;
  });
}

export function downloadJson(name: string, data: unknown) {
  downloadText(name, JSON.stringify(data, null, 2));
}

export function downloadText(name: string, data: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
