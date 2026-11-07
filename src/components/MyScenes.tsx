import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CarFront } from 'lucide-react';
import { serializeEvidence } from '../domain/evidence';
import {
  CabinRuntime,
  isTerminal,
  previewVehicle,
  runStatusLabels,
  type RunSnapshot,
} from '../domain/runtime';
import {
  napRestored,
  parseScenePackage,
  voiceNapMinutes,
  type ScenePackage,
} from '../domain/scene-package';
import type { Scenario } from '../domain/scenario';
import { downloadText } from '../storage';
import Cabin from './Cabin';
import { scenePackageRequest } from './scenePackageRequest';
import { useReminderAudio } from './useReminderAudio';

async function installedPackage(signal?: AbortSignal): Promise<ScenePackage | null> {
  const data = await scenePackageRequest('/api/vehicle/scene-package', undefined, signal);
  return data.scenePackage === null ? null : parseScenePackage(data.scenePackage);
}

function initialVehicle(scene: Scenario) {
  return { ...previewVehicle(scene), driverRecline: 8, playing: true, track: '轻音乐' };
}

const launchLabels = { touch: '车机点选', voice: '模拟语音' } as const;

function durationLabel(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

export default function MyScenes({ visible }: { visible: boolean }) {
  const [pack, setPack] = useState<ScenePackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [voice, setVoice] = useState('');
  const [source, setSource] = useState<'touch' | 'voice'>('touch');
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [verified, setVerified] = useState<
    Partial<Record<'touch' | 'voice', { version: number; seconds: number }>>
  >({});
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const runtime = useRef<CabinRuntime | null>(null);
  const reminderAudio = useReminderAudio(run);
  const active = Boolean(run && !isTerminal(run.status));
  const alert = run?.events.find((event) => event.kind === 'reminder');
  const vehicle = run?.vehicle ?? (pack ? initialVehicle(pack.scenario) : undefined);
  const effectiveReminder = run?.scenario.reminder;

  useEffect(() => {
    if (!run || effectiveReminder?.kind !== 'wake' || !napRestored(run)) return;
    setVerified((previous) => ({
      ...previous,
      [source]: { version: run.scenario.version, seconds: effectiveReminder.afterSeconds },
    }));
  }, [run, effectiveReminder, source]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setLoading(true);
    installedPackage(controller.signal)
      .then(setPack)
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [visible]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = runtime.current?.step();
      if (next) {
        setRun(next);
        if (isTerminal(next.status)) setPlaying(false);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [playing]);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setPack(await installedPackage());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取已安装场景失败。');
    } finally {
      setLoading(false);
    }
  }

  function launch(via: 'touch' | 'voice', minutes?: number) {
    if (!pack || (runtime.current && !isTerminal(runtime.current.snapshot().status))) return;
    const scene =
      minutes === undefined
        ? pack.scenario
        : { ...pack.scenario, reminder: { kind: 'wake' as const, afterSeconds: minutes * 60 } };
    reminderAudio.enable();
    runtime.current = new CabinRuntime(
      scene,
      initialVehicle(scene),
      'none',
      `vehicle-${via}-nap-v${pack.version}-${Date.now()}`,
    );
    setSource(via);
    setRun(runtime.current.snapshot());
    setPlaying(true);
    setError('');
  }

  function startFromVoice(event: FormEvent) {
    event.preventDefault();
    try {
      launch('voice', voiceNapMinutes(voice));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '未识别到午休指令。');
    }
  }

  function advance(target?: number) {
    setPlaying(false);
    const next =
      target === undefined ? runtime.current?.step() : runtime.current?.advanceTo(target);
    if (next) setRun(next);
  }

  return (
    <section className="panel vehicle-scenes" aria-label="模拟车端我的场景">
      <div className="panel-heading">
        <span>
          <CarFront size={17} /> 我的场景
        </span>
        <button className="button secondary" disabled={active || loading} onClick={refresh}>
          刷新车端场景
        </button>
      </div>
      <div className="scene-delivery-content">
        {!pack ? (
          <p className="muted">
            {loading ? '正在读取已安装场景…' : '车端尚未收到场景包。请在工作室发布并下发定时午休。'}
          </p>
        ) : (
          <>
            <div className="vehicle-package">
              <div>
                <strong>{pack.scenario.name}</strong>
                <span className="pill">已安装 v{pack.version}</span>
              </div>
              <button
                className="button primary"
                disabled={active || loading}
                onClick={() => launch('touch')}
              >
                点选启动
              </button>
            </div>
            <form className="vehicle-voice" onSubmit={startFromVoice}>
              <label htmlFor="vehicle-voice-text">模拟语音识别文本</label>
              <div className="scene-delivery-actions">
                <input
                  id="vehicle-voice-text"
                  value={voice}
                  maxLength={80}
                  placeholder="开始午休 15 分钟"
                  onChange={(event) => setVoice(event.target.value)}
                />
                <button className="button secondary" disabled={active || loading || !voice.trim()}>
                  语音启动
                </button>
              </div>
            </form>
            <div className="vehicle-proof" aria-label="车端闭环验收">
              <h2>车端闭环验收 · v{pack.version}</h2>
              <ul>
                {(['touch', 'voice'] as const).map((mode) => {
                  const result = verified[mode];
                  const passed = result?.version === pack.version;
                  return (
                    <li key={mode} className={passed ? 'done' : ''}>
                      <strong>{launchLabels[mode]}</strong>
                      <span>
                        {passed ? `${durationLabel(result.seconds)} · 已唤醒并恢复` : '尚未验证'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
        {error && (
          <p className="compile-error" role="alert">
            {error}
          </p>
        )}
        {run && (
          <>
            <p role="status" className="vehicle-run-status">
              {source === 'voice' ? '语音启动' : '点选启动'} · v{run.scenario.version} ·{' '}
              {runStatusLabels[run.status]}
              {effectiveReminder?.kind === 'wake' &&
                ` · 本次 ${durationLabel(effectiveReminder.afterSeconds)}`}
            </p>
            {run.reminderDueAt !== undefined && (
              <p role="status">距离唤醒还有 {run.reminderDueAt - run.time} 个虚拟秒</p>
            )}
            <div className="scene-delivery-actions">
              <button
                className="button secondary"
                disabled={!active}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? '暂停计时' : '继续计时'}
              </button>
              <button className="button secondary" disabled={!active} onClick={() => advance()}>
                车端单步
              </button>
              {run.reminderDueAt !== undefined && (
                <button className="button secondary" onClick={() => advance(run.reminderDueAt)}>
                  快进到车端唤醒
                </button>
              )}
              <button
                className="text-button"
                onClick={() => {
                  try {
                    downloadText(`${run.runId}.json`, serializeEvidence(run));
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : '证据导出失败。');
                  }
                }}
              >
                导出车端运行证据
              </button>
            </div>
            {alert && (
              <p className="feedback-warning" role="alert">
                {alert.detail}
              </p>
            )}
            {napRestored(run) && (
              <p className="vehicle-run-status" role="status">
                座椅、空调和媒体已恢复原设置
              </p>
            )}
          </>
        )}
        {vehicle && (
          <dl className="vehicle-settings" aria-label="车端设置回读">
            <div>
              <dt>主驾座椅</dt>
              <dd>{vehicle.driverRecline ?? 8}°</dd>
            </div>
            <div>
              <dt>空调</dt>
              <dd>
                {vehicle.climatePower ? '开启' : '关闭'} · {vehicle.targetTemperature}°C
              </dd>
            </div>
            <div>
              <dt>媒体</dt>
              <dd>{vehicle.playing ? vehicle.track : '未播放'}</dd>
            </div>
          </dl>
        )}
      </div>
      {vehicle && <Cabin vehicle={vehicle} active={active && playing} />}
    </section>
  );
}
