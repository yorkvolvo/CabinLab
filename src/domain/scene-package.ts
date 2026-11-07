import { z } from 'zod';
import { inspectEvidence } from './evidence';
import { scenarioSchema, validateScenario } from './scenario';
import type { RunSnapshot } from './runtime';

function isInstallableNap(scene: z.infer<typeof scenarioSchema>): boolean {
  return (
    scene.id === 'nap' &&
    scene.templateId === 'nap' &&
    scene.confirmed &&
    scene.guard === 'parked' &&
    scene.exit === 'cancel-pending-restore-settings' &&
    scene.reminder?.kind === 'wake' &&
    Boolean(validateScenario(scene).scenario)
  );
}

const scenePackageSchema = z
  .object({
    format: z.literal('cabinlab.scene-package'),
    schemaVersion: z.literal(1),
    sceneId: z.literal('nap'),
    version: scenarioSchema.shape.version,
    scenario: scenarioSchema,
  })
  .strict()
  .refine(({ version, scenario }) => version === scenario.version && isInstallableNap(scenario), {
    message: '场景包必须是已确认且支持恢复的定时午休版本',
  });

export type ScenePackage = z.infer<typeof scenePackageSchema>;

export function parseScenePackage(input: unknown): ScenePackage {
  const result = scenePackageSchema.safeParse(input);
  if (!result.success) throw new Error('场景包无效，无法安装或启动。');
  return result.data;
}

export function napRestored(run: RunSnapshot): boolean {
  const { vehicle, initialState } = run;
  return (
    run.status === 'completed' &&
    run.events.filter((event) => event.kind === 'reminder').length === 1 &&
    run.events.some((event) => event.kind === 'restored') &&
    !run.events.some((event) => event.kind === 'restore-skipped') &&
    vehicle.driverRecline === initialState.driverRecline &&
    vehicle.climatePower === initialState.climatePower &&
    vehicle.targetTemperature === initialState.targetTemperature &&
    vehicle.playing === initialState.playing &&
    vehicle.track === initialState.track
  );
}

export function packageNapPreview(evidence: string): ScenePackage {
  const { replayed } = inspectEvidence(evidence);
  if (!isInstallableNap(replayed.scenario) || !napRestored(replayed))
    throw new Error('请先确认定时午休版本，再完成唤醒及设置恢复预演。');
  return parseScenePackage({
    format: 'cabinlab.scene-package',
    schemaVersion: 1,
    sceneId: 'nap',
    version: replayed.scenario.version,
    scenario: replayed.scenario,
  });
}

export function voiceNapMinutes(text: string): number | undefined {
  const match = text
    .trim()
    .match(/^(?:开始|启动|打开)\s*(?:定时)?午休(?:\s*(\d{1,2})\s*分钟)?[。！!]?$/);
  if (!match) throw new Error('试试「开始午休」或「开始午休 15 分钟」。');
  if (match[1] === undefined) return undefined;
  const minutes = Number(match[1]);
  if (minutes < 1 || minutes > 30) throw new Error('午休时长须在 1–30 分钟之间。');
  return minutes;
}
