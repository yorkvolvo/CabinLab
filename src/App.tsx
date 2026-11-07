import { useEffect, useRef, useState } from 'react';
import packageInfo from '../package.json';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  AlarmClock,
  BatteryCharging,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  CloudRain,
  Code2,
  Download,
  FileCheck2,
  FlaskConical,
  Layers3,
  Leaf,
  LoaderCircle,
  Moon,
  MapPin,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Thermometer,
  Upload,
  WandSparkles,
  Wind,
  X,
} from 'lucide-react';
import {
  catalog,
  reminderLabel,
  seatLabels,
  signalLabels,
  validateScenario,
  type Action,
  type Scenario,
} from './domain/scenario';
import { cloneTemplate, templates } from './domain/templates';
import { assumptionsFor, type CompileResult } from './domain/compiler';
import {
  CabinRuntime,
  faultSchema,
  previewVehicle,
  isTerminal,
  replayEvidence,
  runStatusLabels as statusLabels,
  type Fault,
  type RunSnapshot,
  type Vehicle,
} from './domain/runtime';
import { verifyScenario, type VerificationReport } from './domain/verification';
import Cabin from './components/Cabin';
import Verification from './components/Verification';
import VersionComparison, { ScenarioDiff } from './components/VersionComparison';
import EvidenceInspector from './components/EvidenceInspector';
import { downloadJson, readVersions, storageKey } from './storage';

const icons = {
  rest: Moon,
  reading: BookOpen,
  refresh: Leaf,
  warmup: Thermometer,
  cooldown: Wind,
  night: Moon,
  nap: AlarmClock,
  charging: BatteryCharging,
  rainDefog: CloudRain,
  pickup: MapPin,
};
const eventLabels = {
  armed: '就绪',
  condition: '计时',
  reset: '重置',
  triggered: '触发',
  accepted: '已接受',
  confirmed: '已达成',
  timeout: '超时',
  rejected: '已拒绝',
  unknown: '结果未知',
  blocked: '已阻止',
  input: '信号',
  manual: '手动',
  cancelled: '取消',
  stopped: '退出',
  waiting: '等待',
  reminder: '提醒',
  completed: '结果',
};

export default function App() {
  const [versions, setVersions] = useState(readVersions);
  const [selected, setSelected] = useState<Scenario>(
    () => versions.filter((s) => s.templateId === 'rest').at(-1) ?? cloneTemplate('rest'),
  );
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [prompt, setPrompt] = useState(templates[selected.templateId].sourcePrompt);
  const [compileMessage, setCompileMessage] = useState('');
  const [compileIntent, setCompileIntent] = useState<'create' | 'modify'>('create');
  const [compileError, setCompileError] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [providerMode, setProviderMode] = useState<'demo' | 'model' | 'offline'>('offline');
  const [tab, setTab] = useState<'workbench' | 'verification' | 'catalog' | 'evidence'>(
    'workbench',
  );
  const [vehicle, setVehicle] = useState<Vehicle>(() => previewVehicle(selected));
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fault, setFault] = useState<Fault>('none');
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [toast, setToast] = useState('');
  const [jsonOpen, setJsonOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const runtime = useRef<CabinRuntime | null>(null);
  const timeline = useRef<HTMLDivElement | null>(null);
  const compileAbort = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const reminderAudio = useRef<AudioContext | null>(null);
  const playedReminder = useRef('');
  const scenario = draft ?? selected;
  const currentVersions = versions.filter((s) => s.templateId === selected.templateId);
  const currentSignal = signalLabels[scenario.trigger.signal];
  const reminder = scenario.reminder;
  const hasSeatInputs = Boolean(
    reminder || scenario.actions.some((action) => action.capability === 'seat.recline'),
  );
  const latestReminder = snapshot?.events.filter((event) => event.kind === 'reminder').at(-1);
  const active = snapshot && !isTerminal(snapshot.status);
  const draftErrors = draft ? validateScenario(draft).errors : [];
  const manualLight = selected.actions.some((action) => action.capability === 'ambient.light');

  useEffect(() => {
    if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [snapshot?.events.length]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('服务不可用');
        return r.json();
      })
      .then((data: { mode?: string }) => setProviderMode(data.mode === 'model' ? 'model' : 'demo'))
      .catch(() => {
        if (!controller.signal.aborted) setProviderMode('offline');
      });
    return () => {
      controller.abort();
      compileAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(versions));
    } catch {
      setToast('浏览器存储不可用，版本仍保留在本次会话中；请导出场景。');
    }
  }, [versions]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!jsonOpen && !helpOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setJsonOpen(false);
        setHelpOpen(false);
      }
      if (event.key !== 'Tab') return;
      const elements = document
        .querySelector('.modal')
        ?.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [jsonOpen, helpOpen]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = runtime.current?.step();
      if (next) {
        setSnapshot(next);
        setVehicle(next.vehicle);
        if (isTerminal(next.status)) setPlaying(false);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [playing]);
  useEffect(
    () => () => {
      const context = reminderAudio.current;
      reminderAudio.current = null;
      if (context) void context.close().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!snapshot || !latestReminder) return;
    const marker = `${snapshot.runId}:${latestReminder.index}`;
    if (playedReminder.current === marker) return;
    playedReminder.current = marker;
    const context = reminderAudio.current;
    if (context?.state !== 'running') return;
    for (const [index, frequency] of [660, 880].entries()) {
      const tone = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime + index * 0.22;
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.12, startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.18);
      tone.connect(gain).connect(context.destination);
      tone.start(startAt);
      tone.stop(startAt + 0.18);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
    }
  }, [snapshot, latestReminder]);

  function enableReminderAudio() {
    if (!selected.reminder) return;
    try {
      reminderAudio.current ??= new AudioContext();
      void reminderAudio.current.resume().catch(() => {});
    } catch {
      /* 视觉提醒仍可使用。 */
    }
  }

  function haltAndReset(next: Scenario = selected) {
    runtime.current?.cancel();
    runtime.current = null;
    setPlaying(false);
    setSnapshot(null);
    setVehicle(previewVehicle(next));
    setReport(null);
  }
  function selectScenario(next: Scenario) {
    requestId.current++;
    compileAbort.current?.abort();
    compileAbort.current = null;
    setCompiling(false);
    haltAndReset(next);
    setSelected(next);
    setDraft(null);
    setPrompt(templates[next.templateId].sourcePrompt);
    setCompileMessage('');
    setCompileError(false);
    setCompileIntent('create');
    setFault('none');
    setTab('workbench');
  }
  function editScenario(patch: Partial<Scenario>) {
    if (compileAbort.current) cancelCompile();
    if (active) {
      runtime.current?.cancel();
      setPlaying(false);
      setSnapshot(runtime.current?.snapshot() ?? null);
    }
    setDraft({ ...structuredClone(scenario), ...patch, confirmed: false });
    setReport(null);
  }
  async function generate() {
    if (compiling || compileAbort.current || draft || prompt.trim().length < 4) return;
    const id = ++requestId.current;
    const controller = new AbortController();
    compileAbort.current = controller;
    setCompiling(true);
    setCompileMessage('');
    setCompileError(false);
    setPlaying(false);
    try {
      const response = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          templateId: selected.templateId,
          intent: compileIntent,
          ...(compileIntent === 'modify' ? { baseScenario: selected } : {}),
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as CompileResult & { error?: string };
      if (!response.ok) throw new Error(data.error || '生成失败，请重试');
      if (id !== requestId.current) return;
      const parsed = validateScenario(data.draft);
      if (!parsed.scenario) throw new Error('返回的场景结构不合法，已阻止加载');
      haltAndReset(parsed.scenario);
      setDraft({ ...parsed.scenario, confirmed: false });
      setCompileMessage(data.message);
      setProviderMode(data.mode);
    } catch (e) {
      if (!controller.signal.aborted && id === requestId.current) {
        setCompileError(true);
        setCompileMessage(e instanceof Error ? e.message : '生成失败');
      }
    } finally {
      if (id === requestId.current) {
        setCompiling(false);
        compileAbort.current = null;
      }
    }
  }
  function cancelCompile() {
    requestId.current++;
    compileAbort.current?.abort();
    compileAbort.current = null;
    setCompiling(false);
    setCompileError(false);
    setCompileMessage('已取消生成，可以修改需求后重试。');
  }
  function updatePrompt(next: string) {
    if (compileAbort.current) cancelCompile();
    setPrompt(next);
    setCompileError(false);
    setCompileMessage('');
  }
  function newRequest() {
    cancelCompile();
    haltAndReset();
    setTab('workbench');
    setPrompt('');
    setDraft(null);
    setCompileIntent('create');
    setCompileMessage(
      '选择停车休息、阅读或空气清新需求。本地模板只提供已知示例建议；明确数值请使用“修改当前场景”。',
    );
  }
  function confirmDraft() {
    if (!draft) return;
    const parsed = validateScenario(draft);
    if (!parsed.scenario) {
      setToast(parsed.errors.join('；'));
      return;
    }
    const matching = versions.filter((s) => s.templateId === draft.templateId);
    const version = Math.max(0, ...matching.map((s) => s.version)) + 1;
    if (version > 999) {
      setToast('版本数已达到上限，请导出后整理本地数据。');
      return;
    }
    const next = { ...parsed.scenario, id: draft.templateId, version, confirmed: true };
    setVersions((prev) => [
      ...prev.filter((s) => s.templateId !== draft.templateId),
      ...matching.slice(-29),
      next,
    ]);
    haltAndReset(next);
    setSelected(next);
    setDraft(null);
    setFault('none');
    setToast(`v${version} 已确认并保存到本地`);
  }
  function start() {
    if (draft) {
      setToast('请先核对并确认候选场景');
      return;
    }
    enableReminderAudio();
    if (runtime.current && !isTerminal(runtime.current.snapshot().status)) {
      setPlaying(true);
      return;
    }
    runtime.current = new CabinRuntime(selected, vehicle, fault, `run-${Date.now()}`);
    const next = runtime.current.snapshot();
    setSnapshot(next);
    setVehicle(next.vehicle);
    setPlaying(!isTerminal(next.status));
  }
  function step() {
    if (draft) return;
    if (snapshot && isTerminal(snapshot.status)) {
      setToast('本次运行已结束，点击开始预演可开启新运行。');
      return;
    }
    enableReminderAudio();
    setPlaying(false);
    if (!runtime.current)
      runtime.current = new CabinRuntime(selected, vehicle, fault, `run-${Date.now()}`);
    const next = runtime.current.step();
    setSnapshot(next);
    setVehicle(next.vehicle);
  }
  function stop() {
    setPlaying(false);
    const next = runtime.current?.cancel();
    if (next) setSnapshot(next);
  }
  function jumpToWake() {
    if (draft || snapshot?.status !== 'waiting' || snapshot.reminderDueAt === undefined) return;
    enableReminderAudio();
    setPlaying(false);
    const next = runtime.current?.advanceTo(snapshot.reminderDueAt);
    if (next) {
      setSnapshot(next);
      setVehicle(next.vehicle);
    }
  }
  function replay() {
    if (!snapshot) return;
    setPlaying(false);
    try {
      runtime.current = replayEvidence(snapshot);
    } catch {
      setToast('当前记录无法重放，请导出证据后核查运行时与输入轨迹。');
      return;
    }
    const next = runtime.current.snapshot();
    const event = next.events.filter((item) => item.kind === 'reminder').at(-1);
    if (event) playedReminder.current = `${next.runId}:${event.index}`;
    setSnapshot(next);
    setVehicle(next.vehicle);
    setToast('已按原始状态、故障和输入轨迹重放，执行证据可复现。');
  }
  function changeSignals(patch: Parameters<CabinRuntime['setSignals']>[0]) {
    if (runtime.current && active) {
      const next = runtime.current.setSignals(patch);
      setSnapshot(next);
      setVehicle(next.vehicle);
      if (isTerminal(next.status)) setPlaying(false);
    } else setVehicle((prev) => ({ ...prev, ...patch }));
  }
  function manualOverride() {
    const action: Action = manualLight
      ? { capability: 'ambient.light', value: 25 }
      : { capability: 'climate.temperature', value: 27 };
    if (runtime.current && active) {
      const next = runtime.current.manual(action);
      setSnapshot(next);
      setVehicle(next.vehicle);
    } else {
      setVehicle((prev) => ({
        ...prev,
        ...(action.capability === 'ambient.light' ? { light: 25 } : { targetTemperature: 27 }),
      }));
    }
    setToast(
      action.capability === 'ambient.light'
        ? '用户接管：阅读灯设为 25%'
        : '用户接管：空调目标温度设为 27°C',
    );
  }
  function verify() {
    if (draft) {
      setToast('请先确认并保存当前修改，再运行验证');
      return;
    }
    const next = verifyScenario(selected);
    setReport(next);
    setToast(
      next.passed === next.total
        ? `v${selected.version} 的 ${next.total} 项验证全部通过`
        : `发现 ${next.total - next.passed} 项偏离产品预期的行为`,
    );
  }
  function updateAction(index: number, value: string | number | boolean) {
    const actions = structuredClone(scenario.actions);
    actions[index] = { ...actions[index], value } as Action;
    editScenario({ actions });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab('workbench');
          }}
        >
          <span className="brand-mark">
            <FlaskConical size={22} strokeWidth={1.8} />
          </span>
          <span>
            Cabin<span className="brand-light">Lab</span>
            <small>场景试验场</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-dot" /> 个人实验空间 <span className="mono">01</span>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <button
          className={`nav-item ${tab === 'workbench' ? 'active' : ''}`}
          onClick={() => setTab('workbench')}
        >
          <Layers3 size={17} />
          场景工作台
          <ChevronRight size={14} />
        </button>
        <button
          className={`nav-item ${tab === 'verification' ? 'active' : ''}`}
          onClick={() => setTab('verification')}
        >
          <FileCheck2 size={17} />
          验证报告
          {report && (
            <span className="nav-count">
              {report.passed}/{report.total}
            </span>
          )}
        </button>
        <button
          className={`nav-item ${tab === 'catalog' ? 'active' : ''}`}
          onClick={() => setTab('catalog')}
        >
          <Code2 size={17} />
          能力目录
          <span className="nav-count">{String(Object.keys(catalog).length).padStart(2, '0')}</span>
        </button>
        <button
          className={`nav-item ${tab === 'evidence' ? 'active' : ''}`}
          onClick={() => setTab('evidence')}
        >
          <Upload size={17} />
          证据复核
        </button>
        <div className="nav-section-heading">
          <span className="nav-label">场景库</span>
          <span className="small muted">{Object.keys(templates).length} 个模板</span>
        </div>
        <div className="scenario-list">
          {Object.values(templates).map((item, index) => {
            const Icon = icons[item.templateId];
            return (
              <button
                key={item.id}
                className={`scenario-nav ${selected.templateId === item.templateId ? 'selected' : ''}`}
                onClick={() =>
                  selectScenario(
                    versions.filter((s) => s.templateId === item.templateId).at(-1) ?? item,
                  )
                }
              >
                <Icon size={16} />
                <span>
                  {item.name}
                  <small>
                    {
                      [
                        '降温 / 音乐',
                        '灯光 / 媒体',
                        '空调 / 通风',
                        '暖风 / 预热',
                        '降温 / 送风',
                        '柔光 / 白噪音',
                        '座椅 / 定时唤醒',
                        '充电 / 到点提醒',
                      ][index]
                    }
                  </small>
                </span>
                <span className="mono scenario-index">0{index + 1}</span>
              </button>
            );
          })}
        </div>
        <button className="new-scenario" onClick={newRequest}>
          <Plus size={15} />
          编排新需求
        </button>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="live-dot" />
            <span>
              本地实验，放心探索<small>所有设备动作均在虚拟座舱内</small>
            </span>
          </div>
          <button className="help-button" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={15} />
            快速上手
            <ArrowUpRight size={14} />
          </button>
          <span className="sidebar-version mono">CABINLAB / v{packageInfo.version}</span>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            工作空间
            <ChevronRight size={12} />
            <span>
              {tab === 'catalog'
                ? '能力目录'
                : tab === 'verification'
                  ? '验证报告'
                  : tab === 'evidence'
                    ? '证据复核'
                    : '场景工作台'}
            </span>
          </div>
          <div className="topbar-right">
            <span className="mode-badge">
              <span className={`live-dot ${providerMode === 'offline' ? 'offline' : ''}`} />
              {providerMode === 'model'
                ? '模型服务已配置'
                : providerMode === 'demo'
                  ? '本地模板模式'
                  : '服务连接中 / 离线'}
            </span>
            <div className="avatar">CL</div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="tiny-line" /> SCENARIO PLAYGROUND
              </div>
              <h1>
                {tab === 'evidence'
                  ? '导入证据，复现实验。'
                  : tab === 'catalog'
                    ? '能力有边界，执行有依据。'
                    : tab === 'verification'
                      ? '让每一次执行，都有证据。'
                      : '把想法，变成可验证的场景。'}
              </h1>
              <p>
                {tab === 'evidence'
                  ? '在独立虚拟运行中，核对输入、事件与设备终态。'
                  : tab === 'catalog'
                    ? `${Object.keys(catalog).length} 个白名单能力 · 参数校验 · 前置条件 · 状态回读`
                    : tab === 'verification'
                      ? '使用独立产品基线，验证正常路径、边界条件和异常行为。'
                      : '用自然语言编排，在虚拟座舱预演，带着证据启程。'}
              </p>
            </div>
            <button
              className="button secondary export-top"
              onClick={() =>
                downloadJson(`cabinlab-${selected.id}-v${selected.version}.json`, {
                  format: 'cabinlab.experiment',
                  schemaVersion: 1,
                  scenario: selected,
                  run: snapshot,
                  verification: report,
                })
              }
            >
              <Download size={14} />
              导出实验
            </button>
          </div>

          {tab === 'evidence' ? (
            <EvidenceInspector />
          ) : tab === 'catalog' ? (
            <div className="catalog-grid">
              {Object.entries(catalog).map(([id, item], index) => (
                <section className="panel capability-card" key={id}>
                  <div className="capability-number mono">
                    0{index + 1}
                    <ShieldCheck size={17} />
                  </div>
                  <h2>{item.label}</h2>
                  <code>{id}</code>
                  <dl>
                    <dt>参数范围</dt>
                    <dd>{item.range}</dd>
                    <dt>前置条件</dt>
                    <dd>{item.precondition}</dd>
                    <dt>可观测结果</dt>
                    <dd>{item.result}</dd>
                    <dt>接入边界</dt>
                    <dd>{item.boundary}</dd>
                  </dl>
                  <span className="capability-footer">
                    <Check size={12} />
                    确定性校验 · 模拟执行
                  </span>
                </section>
              ))}
            </div>
          ) : tab === 'verification' ? (
            <div className="report-layout">
              <Verification report={report} onRun={verify} />
              <section className="panel contract-card">
                <span className="eyebrow">INDEPENDENT ORACLE</span>
                <h2>
                  验证的答案，
                  <br />
                  不由模型自己决定。
                </h2>
                <p>
                  当前测试以「{templates[selected.templateId].name}
                  」已确认模板为产品基线。你可以修改场景，但测试预期仍保持不变。
                </p>
                <div className="contract-steps">
                  <span>01 · 读取当前场景版本</span>
                  <ArrowDown size={15} />
                  <span>02 · 注入固定输入与异常</span>
                  <ArrowDown size={15} />
                  <span>03 · 用独立断言核对行为</span>
                </div>
                <p className="small muted">
                  自定义需求可能合理地偏离模板基线。通过报告检查差异；新需求需要另行定义并确认产品预期。
                </p>
              </section>
            </div>
          ) : (
            <>
              <div className="workspace-toolbar">
                <div>
                  <span className="scenario-dot" />
                  <strong>{scenario.name}</strong>
                  <span className={`pill ${draft ? 'warning' : ''}`}>
                    {draft ? '待确认草案' : selected.version === 1 ? '已确认示例' : '已确认版本'}
                  </span>
                </div>
                <div>
                  <label className="version-picker">
                    版本
                    <select
                      aria-label="场景版本"
                      value={selected.version}
                      disabled={Boolean(draft)}
                      onChange={(e) => {
                        const next = currentVersions.find(
                          (s) => s.version === Number(e.target.value),
                        );
                        if (next) selectScenario(next);
                      }}
                    >
                      {currentVersions.map((s) => (
                        <option key={s.version} value={s.version}>
                          v{s.version}
                          {s.version === 1 ? ' · 模板基线' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="icon-button"
                    aria-label="查看场景 DSL"
                    title="查看场景 DSL"
                    onClick={() => setJsonOpen(true)}
                  >
                    <Code2 size={17} />
                  </button>
                </div>
              </div>
              <VersionComparison
                key={`${selected.templateId}-${selected.version}`}
                scenario={selected}
                versions={currentVersions}
              />
              <div className="workbench-grid">
                <div className="compose-column">
                  <section className="panel composer">
                    <div className="panel-heading">
                      <span>
                        <Sparkles size={16} /> 描述你的场景
                      </span>
                      <span className="step-number mono">01</span>
                    </div>
                    <div className="compile-intent" role="group" aria-label="需求操作">
                      {(['create', 'modify'] as const).map((intent) => (
                        <button
                          key={intent}
                          aria-pressed={compileIntent === intent}
                          disabled={Boolean(draft)}
                          onClick={() => {
                            setCompileIntent(intent);
                            updatePrompt(
                              intent === 'create'
                                ? templates[selected.templateId].sourcePrompt
                                : '',
                            );
                          }}
                        >
                          {intent === 'create' ? '创建场景' : '修改当前场景'}
                        </button>
                      ))}
                    </div>
                    {compileIntent === 'modify' && (
                      <p className="edit-context">
                        基于「{selected.name} · v{selected.version}」；只修改明确提到的参数。
                      </p>
                    )}
                    <label className="sr-only" htmlFor="prompt">
                      自然语言需求
                    </label>
                    <textarea
                      id="prompt"
                      value={prompt}
                      maxLength={2000}
                      placeholder={
                        compileIntent === 'modify'
                          ? '例如：把持续时间改为 8 秒，目标温度设为 24°C'
                          : '例如：停车休息时，太热就开空调，放点轻音乐……'
                      }
                      onChange={(e) => updatePrompt(e.target.value)}
                    />
                    <div className="prompt-footer">
                      <span>{prompt.length} / 2000</span>
                      <span>中文自然语言</span>
                    </div>
                    <button
                      className="button primary generate-button"
                      disabled={
                        compiling ||
                        Boolean(draft) ||
                        prompt.trim().length < 4 ||
                        providerMode === 'offline'
                      }
                      onClick={generate}
                    >
                      {compiling ? (
                        <LoaderCircle size={15} className="spinning" />
                      ) : (
                        <WandSparkles size={15} />
                      )}
                      {compiling
                        ? '正在编排…'
                        : compileIntent === 'modify'
                          ? '生成修改草案'
                          : '生成场景'}
                      <ArrowRight size={15} />
                    </button>
                    {compiling && (
                      <button className="text-button cancel-generation" onClick={cancelCompile}>
                        取消生成
                      </button>
                    )}
                    <p className="mode-hint">
                      {providerMode === 'model'
                        ? '服务端模型编译 · 执行前需要确认'
                        : '本地模板建议 · 未调用实时 AI'}
                    </p>
                    {compileIntent === 'modify' && (
                      <details className="supported-edits">
                        <summary>本地支持哪些修改？</summary>
                        <p>
                          支持持续时间（秒）、触发阈值（当前信号单位）和已有动作的目标温度（°C）、音量（%）、风量（档）、亮度（%）。用逗号分隔多项，所有内容都必须匹配；模糊值、增删动作和退出恢复需要另行明确。
                        </p>
                        <button
                          className="text-button"
                          disabled={Boolean(draft) || compiling}
                          onClick={() => updatePrompt('把持续时间改为 0 秒')}
                        >
                          填入回归实验：持续时间改为 0 秒
                        </button>
                      </details>
                    )}
                    {compileMessage && (
                      <p
                        className={`compile-message ${compileError ? 'compile-error' : ''}`}
                        role={compileError ? 'alert' : 'status'}
                      >
                        {compileMessage}
                      </p>
                    )}
                  </section>

                  <section className="panel scenario-definition">
                    <div className="panel-heading">
                      <span>
                        <SlidersHorizontal size={16} /> 场景编排
                      </span>
                      <span className="step-number mono">02</span>
                    </div>
                    <p className="scenario-summary">{scenario.description}</p>
                    <div className="flow-body">
                      <div className="flow-step">
                        <span className="flow-dot" />
                        <span className="flow-label">WHEN / 触发条件</span>
                        <h3>
                          {currentSignal.label}{' '}
                          {scenario.trigger.operator === 'gt' ? '高于' : '低于'}
                        </h3>
                        <div className="trigger-inputs">
                          <label>
                            <input
                              aria-label="触发阈值"
                              type="number"
                              min={currentSignal.min}
                              max={currentSignal.max}
                              value={scenario.trigger.threshold}
                              onChange={(e) =>
                                editScenario({
                                  trigger: {
                                    ...scenario.trigger,
                                    threshold: Number(e.target.value),
                                  },
                                })
                              }
                            />
                            <span>{currentSignal.unit}</span>
                          </label>
                          <span>持续</span>
                          <label>
                            <input
                              aria-label="持续时间"
                              type="number"
                              min="0"
                              max="60"
                              value={scenario.trigger.holdSeconds}
                              onChange={(e) =>
                                editScenario({
                                  trigger: {
                                    ...scenario.trigger,
                                    holdSeconds: Number(e.target.value),
                                  },
                                })
                              }
                            />
                            <span>秒</span>
                          </label>
                        </div>
                        <span className="condition-chip">
                          <ShieldCheck size={11} /> P 挡 + 车速为 0
                          {reminder?.kind === 'charge' ? ' + 正在充电' : ''}
                        </span>
                      </div>
                      <div className="flow-step">
                        <span className="flow-dot" />
                        <span className="flow-label">THEN / 执行动作</span>
                        <div className="actions-list">
                          {scenario.actions.map((action, index) => (
                            <div className="action-row" key={action.capability}>
                              <span className="action-order mono">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <label>
                                <span>
                                  {action.capability === 'seat.recline'
                                    ? `${seatLabels[action.seat]}${catalog[action.capability].label}`
                                    : catalog[action.capability].label}
                                </span>
                                {typeof action.value === 'number' ? (
                                  <span className="action-number">
                                    <input
                                      aria-label={catalog[action.capability].label}
                                      type="number"
                                      value={action.value}
                                      min={
                                        action.capability === 'climate.temperature'
                                          ? 16
                                          : action.capability === 'climate.fan'
                                            ? 1
                                            : 0
                                      }
                                      max={
                                        action.capability === 'climate.temperature'
                                          ? 30
                                          : action.capability === 'climate.fan'
                                            ? 5
                                            : action.capability === 'media.volume'
                                              ? 60
                                              : action.capability === 'seat.recline'
                                                ? 45
                                                : 100
                                      }
                                      onChange={(e) => updateAction(index, Number(e.target.value))}
                                    />
                                    <span>{catalog[action.capability].unit}</span>
                                  </span>
                                ) : typeof action.value === 'boolean' ? (
                                  <span className="action-value">
                                    {action.capability === 'media.pause'
                                      ? '暂停'
                                      : action.value
                                        ? '开启'
                                        : '关闭'}
                                  </span>
                                ) : (
                                  <select
                                    aria-label="音乐曲目"
                                    value={action.value}
                                    onChange={(e) => updateAction(index, e.target.value)}
                                  >
                                    <option>轻音乐</option>
                                    <option>自然白噪音</option>
                                  </select>
                                )}
                              </label>
                            </div>
                          ))}
                        </div>
                        {reminder && (
                          <div className="trigger-inputs">
                            <label>
                              <span>{reminder.kind === 'wake' ? '唤醒时间' : '提醒电量'}</span>
                              <input
                                type="number"
                                min={1}
                                max={reminder.kind === 'wake' ? 1800 : 100}
                                aria-label={reminder.kind === 'wake' ? '唤醒时间' : '提醒电量'}
                                value={
                                  reminder.kind === 'wake'
                                    ? reminder.afterSeconds
                                    : reminder.atPercent
                                }
                                onChange={(event) =>
                                  editScenario({
                                    reminder:
                                      reminder.kind === 'wake'
                                        ? { ...reminder, afterSeconds: Number(event.target.value) }
                                        : { ...reminder, atPercent: Number(event.target.value) },
                                  })
                                }
                              />
                              <span>{reminder.kind === 'wake' ? '秒' : '%'}</span>
                            </label>
                          </div>
                        )}
                      </div>
                      <div className="flow-step last">
                        <span className="flow-dot exit" />
                        <span className="flow-label">EXIT / 退出策略</span>
                        <p>
                          {reminder?.kind === 'charge'
                            ? '拔枪或驶离 → 取消后续动作与提醒'
                            : reminder?.kind === 'wake'
                              ? '驶离停止后续动作；主驾离座取消唤醒'
                              : '开始行驶或条件失效 → 停止后续动作'}
                        </p>
                        <span className="small muted">保留已改变的设备状态 · 不自动恢复</span>
                      </div>
                    </div>
                    {draft && (
                      <div className="confirm-area">
                        <details className="draft-diff" open={compileIntent === 'modify'}>
                          <summary>核对与已确认版本的差异</summary>
                          <ScenarioDiff
                            before={
                              draft.templateId === selected.templateId
                                ? selected
                                : templates[draft.templateId]
                            }
                            after={draft}
                          />
                        </details>
                        <strong>
                          <ShieldCheck size={14} /> 运行前，请确认这些约定
                        </strong>
                        <ul>
                          {assumptionsFor(draft).map((text) => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                        {draftErrors.length > 0 && (
                          <p className="compile-error" role="alert">
                            当前参数超出范围或未填写完整。请检查传感器阈值、持续时间（0–60
                            秒整数）和动作参数后再保存。
                          </p>
                        )}
                        <button
                          className="button primary"
                          disabled={draftErrors.length > 0}
                          onClick={confirmDraft}
                        >
                          <Check size={14} />
                          确认参数并保存版本
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            setDraft(null);
                            setCompileMessage('');
                          }}
                        >
                          放弃本次修改
                        </button>
                      </div>
                    )}
                  </section>
                </div>

                <div className="simulation-column">
                  <section className="panel simulation">
                    <div className="panel-heading">
                      <span>
                        <Radio size={16} /> 虚拟座舱
                      </span>
                      <span className="pill">
                        <span className="live-dot" /> SIMULATION
                      </span>
                    </div>
                    <Cabin vehicle={vehicle} active={Boolean(active && playing)} />
                    <div className="vehicle-readouts">
                      <div>
                        <span>车内温度</span>
                        <strong>
                          {vehicle.temperature}
                          <small>°C</small>
                        </strong>
                      </div>
                      <div>
                        <span>当前挡位</span>
                        <strong>
                          {vehicle.gear}
                          <small>挡</small>
                        </strong>
                      </div>
                      <div>
                        <span>车辆速度</span>
                        <strong>
                          {vehicle.speed}
                          <small>km/h</small>
                        </strong>
                      </div>
                      <div>
                        <span>媒体音量</span>
                        <strong>
                          {vehicle.volume}
                          <small>%</small>
                        </strong>
                      </div>
                    </div>
                    <div className="simulation-controls">
                      <div className="control-heading">
                        <span className="eyebrow">实时信号</span>
                        <span className="small muted">调整输入，观察场景响应</span>
                      </div>
                      <div className="signal-control">
                        <label htmlFor="signal-slider">
                          <Thermometer size={14} />
                          {currentSignal.label}
                          <strong>
                            {vehicle[scenario.trigger.signal] ?? currentSignal.min}{' '}
                            <span>{currentSignal.unit}</span>
                          </strong>
                        </label>
                        <input
                          id="signal-slider"
                          aria-label="模拟传感器数值"
                          type="range"
                          min={currentSignal.min}
                          max={currentSignal.max}
                          step={
                            scenario.trigger.signal === 'illuminance' ||
                            scenario.trigger.signal === 'co2'
                              ? 10
                              : 1
                          }
                          value={vehicle[scenario.trigger.signal] ?? currentSignal.min}
                          onChange={(e) =>
                            changeSignals({ [scenario.trigger.signal]: Number(e.target.value) })
                          }
                        />
                        <div className="range-labels">
                          <span>
                            {currentSignal.min}
                            {currentSignal.unit}
                          </span>
                          <span>
                            触发阈值 {scenario.trigger.threshold}
                            {currentSignal.unit}
                          </span>
                          <span>
                            {currentSignal.max}
                            {currentSignal.unit}
                          </span>
                        </div>
                      </div>
                      {vehicle.frontDefrost !== undefined && (
                        <p className="small muted" role="status">
                          前挡除雾回读：{vehicle.frontDefrost ? '已开启' : '已关闭'}
                        </p>
                      )}
                      {hasSeatInputs && (
                        <div className="reminder-controls" aria-label="座位和充电模拟输入">
                          <label>
                            <input
                              type="checkbox"
                              checked={vehicle.driverOccupied === true}
                              onChange={(event) =>
                                changeSignals({ driverOccupied: event.target.checked })
                              }
                            />{' '}
                            主驾有人
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={vehicle.passengerOccupied === true}
                              onChange={(event) =>
                                changeSignals({ passengerOccupied: event.target.checked })
                              }
                            />{' '}
                            副驾有人
                          </label>
                          {reminder?.kind === 'charge' && (
                            <label>
                              <input
                                type="checkbox"
                                checked={vehicle.charging === true}
                                onChange={(event) =>
                                  changeSignals({ charging: event.target.checked })
                                }
                              />{' '}
                              已插枪充电
                            </label>
                          )}
                          <small>
                            座椅角度：主驾 {vehicle.driverRecline ?? 0}° · 副驾{' '}
                            {vehicle.passengerRecline ?? 0}°
                          </small>
                        </div>
                      )}
                      <div className="drive-controls">
                        <div>
                          <span>挡位</span>
                          <div className="gear-toggle">
                            {(['P', 'N', 'D', 'R'] as const).map((gear) => (
                              <button
                                className={vehicle.gear === gear ? 'selected' : ''}
                                key={gear}
                                aria-label={`切换到 ${gear} 挡`}
                                aria-pressed={vehicle.gear === gear}
                                onClick={() => changeSignals({ gear })}
                              >
                                {gear}
                              </button>
                            ))}
                          </div>
                        </div>
                        <label>
                          车速
                          <input
                            aria-label="模拟车速"
                            type="number"
                            min="0"
                            max="120"
                            value={vehicle.speed}
                            onChange={(e) =>
                              changeSignals({
                                speed: Math.max(0, Math.min(120, Number(e.target.value))),
                              })
                            }
                          />
                          <span>km/h</span>
                        </label>
                      </div>
                      <div className="fault-controls">
                        <label>
                          故障注入
                          <select
                            aria-label="故障注入"
                            disabled={Boolean(active)}
                            value={fault}
                            onChange={(e) => setFault(faultSchema.parse(e.target.value))}
                          >
                            <option value="none">无故障</option>
                            {selected.actions.map((a) => (
                              <optgroup key={a.capability} label={catalog[a.capability].label}>
                                <option value={a.capability}>
                                  {catalog[a.capability].label}超时
                                </option>
                                <option value={`${a.capability}:rejected`}>
                                  {catalog[a.capability].label}请求被拒绝
                                </option>
                                <option value={`${a.capability}:feedback-lost`}>
                                  {catalog[a.capability].label}回读丢失（结果未知）
                                </option>
                              </optgroup>
                            ))}
                          </select>
                        </label>
                        <button className="manual-button" onClick={manualOverride}>
                          <SlidersHorizontal size={12} />
                          {manualLight ? '手动设灯 25%' : '手动设温 27°C'}
                        </button>
                      </div>
                    </div>
                    <div className="playback-bar">
                      <div className="playback-buttons">
                        <button
                          className="button primary play-button"
                          disabled={Boolean(draft)}
                          onClick={playing ? () => setPlaying(false) : start}
                        >
                          {playing ? (
                            <Pause size={14} fill="currentColor" />
                          ) : (
                            <Play size={14} fill="currentColor" />
                          )}
                          {playing ? '暂停' : active ? '继续预演' : '开始预演'}
                        </button>
                        <button
                          className="icon-button"
                          aria-label="单步前进一秒"
                          title="单步 +1s"
                          disabled={Boolean(draft)}
                          onClick={step}
                        >
                          <SkipForward size={16} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="停止预演"
                          title="停止预演"
                          disabled={!active}
                          onClick={stop}
                        >
                          <Square size={14} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="重放执行证据"
                          title="重放执行证据"
                          disabled={!snapshot || Boolean(draft)}
                          onClick={replay}
                        >
                          <RotateCcw size={15} />
                        </button>
                      </div>
                      <div className="simulation-clock mono">
                        <strong data-testid="clock">
                          {String(Math.floor((snapshot?.time ?? 0) / 60)).padStart(2, '0')}:
                          {String((snapshot?.time ?? 0) % 60).padStart(2, '0')}
                        </strong>
                        <span>2× VIRTUAL TIME</span>
                      </div>
                    </div>
                    {snapshot?.events.some((event) => event.kind === 'unknown') && (
                      <p className="feedback-warning" role="status">
                        回读丢失：画面保留最后已知状态，动作可能已执行。同一设备后续控制已阻止，不自动重试；请先核实状态。
                      </p>
                    )}
                    {snapshot?.status === 'waiting' && (
                      <div className="feedback-warning reminder-wait" role="status">
                        <span>
                          {snapshot.reminderDueAt !== undefined
                            ? `距离唤醒还有 ${snapshot.reminderDueAt - snapshot.time} 个虚拟秒`
                            : reminderLabel(snapshot.scenario.reminder)}
                        </span>
                        {snapshot.reminderDueAt !== undefined && (
                          <button className="button secondary" onClick={jumpToWake}>
                            快进到唤醒
                          </button>
                        )}
                      </div>
                    )}
                    {latestReminder && (
                      <p className="feedback-warning" role="alert">
                        {latestReminder.detail}
                      </p>
                    )}
                    <div className="run-status" role="status">
                      <span>
                        <span
                          className={`live-dot ${snapshot?.status === 'partial' || snapshot?.status === 'uncertain' ? 'amber' : ''}`}
                        />
                        {snapshot ? statusLabels[snapshot.status] : '准备就绪'}
                        {active && !playing ? ' · 已暂停' : ''}
                      </span>
                      <span>
                        {snapshot?.status === 'armed'
                          ? `条件持续 ${snapshot.holdElapsed} / ${selected.trigger.holdSeconds}s`
                          : snapshot
                            ? `${snapshot.events.filter((e) => e.kind === 'confirmed').length} 项已达成`
                            : '点击开始，启动虚拟时钟'}
                      </span>
                    </div>
                  </section>

                  <section className="panel timeline">
                    <div className="panel-heading">
                      <span>
                        <Terminal size={15} /> 执行时间线
                      </span>
                      <div>
                        <span className="mono muted">
                          {String(snapshot?.events.length ?? 0).padStart(2, '0')} EVENTS
                        </span>
                        <button
                          className="icon-button"
                          disabled={!snapshot}
                          aria-label="导出运行证据"
                          onClick={() =>
                            snapshot &&
                            downloadJson(
                              `cabinlab-run-v${snapshot.scenario.version}.json`,
                              snapshot,
                            )
                          }
                        >
                          <Download size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="timeline-content" ref={timeline}>
                      {snapshot ? (
                        snapshot.events.map((event) => (
                          <div className={`timeline-event ${event.kind}`} key={event.index}>
                            <span className="event-time mono">
                              {String(event.time).padStart(2, '0')}.0s
                            </span>
                            <span className="event-dot" />
                            <div>
                              <span className="event-label">{eventLabels[event.kind]}</span>
                              <p>{event.detail}</p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="timeline-empty">
                          <span className="terminal-caret">_</span>
                          <p>
                            你的下一次实验，从这里开始。<span>请求、回读与异常将逐条留痕</span>
                          </p>
                        </div>
                      )}
                    </div>
                  </section>
                </div>
                <Verification report={report} onRun={verify} compact />
              </div>
              <footer className="workspace-footer">
                <span>
                  <ShieldCheck size={12} />
                  能力白名单 · 实时守卫 · 可复现证据
                </span>
                <span>
                  先验证，再启程。 <span className="mono">BUILT FOR EXPLORATION</span>
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {(jsonOpen || helpOpen) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setJsonOpen(false);
            setHelpOpen(false);
          }}
        >
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-label={jsonOpen ? '场景 DSL' : '快速上手'}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setJsonOpen(false);
                setHelpOpen(false);
              }
            }}
          >
            <div className="panel-heading">
              <span>{jsonOpen ? '声明式场景 / DSL' : '欢迎来到 CabinLab'}</span>
              <button
                className="icon-button"
                autoFocus
                aria-label="关闭弹窗"
                onClick={() => {
                  setJsonOpen(false);
                  setHelpOpen(false);
                }}
              >
                <X size={18} />
              </button>
            </div>
            {jsonOpen ? (
              <>
                <pre>{JSON.stringify(scenario, null, 2)}</pre>
                <button
                  className="button secondary"
                  onClick={() => downloadJson(`cabinlab-${scenario.id}.json`, scenario)}
                >
                  <Download size={14} />
                  导出场景 JSON
                </button>
              </>
            ) : (
              <div className="help-content">
                <span className="eyebrow">THREE MINUTES, ONE EXPERIMENT</span>
                <h2>
                  从一句想法，
                  <br />
                  走到一份执行证据。
                </h2>
                <ol>
                  <li>
                    <strong>编排</strong> 输入需求，核对阈值、动作与退出策略，确认并保存。
                  </li>
                  <li>
                    <strong>预演</strong> 开始虚拟时钟，调节传感器、挡位或注入故障，观察状态回读。
                  </li>
                  <li>
                    <strong>验证</strong> 在“修改当前场景”输入“把持续时间改为 0
                    秒”，核对差异并保存；展开版本对照，查看固定断言发现的新增失败。
                  </li>
                  <li>
                    <strong>复现</strong>{' '}
                    导出运行证据，再到“证据复核”导入，核对事件与终态是否可以复现。
                  </li>
                </ol>
                <p>
                  默认是本地模板模式。真实模型可在服务端 .env
                  配置。所有车控均为模拟，不连接真实车辆。
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
