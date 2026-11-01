import { validateScenario, type Scenario } from './domain/scenario';
import { templates } from './domain/templates';

export const storageKey = 'cabinlab.scenarios.v1';
export function readVersions(): Scenario[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (Array.isArray(raw) && raw.length <= 90) {
      const valid = raw
        .map((s) => validateScenario(s).scenario)
        .filter((s): s is Scenario => Boolean(s?.confirmed));
      if (Object.keys(templates).every((id) => valid.some((s) => s.templateId === id)))
        return valid;
    }
  } catch {
    /* 无效本地缓存不进入执行器。 */
  }
  return structuredClone(Object.values(templates));
}

export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
