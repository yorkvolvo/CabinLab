import { z } from 'zod';
import {
  actionLabel,
  resourceOf,
  validateScenario,
  type Action,
  type Capability,
  type Resource,
  type Scenario,
} from './scenario';

export const vehicleSchema = z
  .object({
    temperature: z.number().min(16).max(40),
    illuminance: z.number().min(0).max(300),
    co2: z.number().min(400).max(2000),
    gear: z.enum(['P', 'D', 'R', 'N']),
    speed: z.number().min(0).max(120),
    climatePower: z.boolean(),
    targetTemperature: z.number().min(16).max(30),
    fan: z.number().int().min(1).max(5),
    recirculation: z.boolean(),
    playing: z.boolean(),
    track: z.string().nullable(),
    volume: z.number().min(0).max(60),
    light: z.number().min(0).max(100),
  })
  .strict();
export type Vehicle = z.infer<typeof vehicleSchema>;
export type Fault = Capability | 'none';
export type RunStatus = 'armed' | 'executing' | 'completed' | 'partial' | 'stopped' | 'cancelled';
export type EventKind =
  | 'armed'
  | 'condition'
  | 'reset'
  | 'triggered'
  | 'accepted'
  | 'confirmed'
  | 'timeout'
  | 'blocked'
  | 'input'
  | 'manual'
  | 'cancelled'
  | 'stopped'
  | 'completed';
export interface RunEvent {
  index: number;
  time: number;
  kind: EventKind;
  detail: string;
  capability?: Capability;
  state: Vehicle;
}
export type RunCommand =
  | {
      time: number;
      type: 'signals';
      patch: Partial<Pick<Vehicle, 'temperature' | 'illuminance' | 'co2' | 'gear' | 'speed'>>;
    }
  | { time: number; type: 'manual'; action: Action }
  | { time: number; type: 'cancel' };
export interface RunEvidence {
  schemaVersion: 1;
  runId: string;
  scenario: Scenario;
  initialState: Vehicle;
  fault: Fault;
  status: RunStatus;
  time: number;
  vehicle: Vehicle;
  events: RunEvent[];
  commands: RunCommand[];
  caveat: string;
}
export interface RunSnapshot extends RunEvidence {
  progress: number;
  holdElapsed: number;
  locked: Resource[];
  pending?: Capability;
}

export const initialVehicle: Vehicle = {
  temperature: 30,
  illuminance: 60,
  co2: 1400,
  gear: 'P',
  speed: 0,
  climatePower: false,
  targetTemperature: 26,
  fan: 1,
  recirculation: true,
  playing: false,
  track: null,
  volume: 30,
  light: 0,
};

export const isParked = (v: Vehicle) => v.gear === 'P' && v.speed === 0;
export const isTerminal = (status: RunStatus) => !['armed', 'executing'].includes(status);

export class CabinRuntime {
  private readonly scenario: Scenario;
  private readonly initialState: Vehicle;
  private readonly runId: string;
  private vehicle: Vehicle;
  private time = 0;
  private status: RunStatus = 'armed';
  private events: RunEvent[] = [];
  private commands: RunCommand[] = [];
  private conditionSince: number | null = null;
  private fired = false;
  private cursor = 0;
  private pending?: { action: Action; acceptedAt: number };
  private failures = 0;
  private locked = new Set<Resource>();

  constructor(
    scenario: Scenario,
    vehicle: Vehicle = initialVehicle,
    private readonly fault: Fault = 'none',
    runId = 'local-run',
  ) {
    const validated = validateScenario(scenario);
    if (!validated.scenario) throw new Error(validated.errors.join('；'));
    if (!validated.scenario.confirmed) throw new Error('请先确认场景参数与退出策略');
    this.scenario = structuredClone(validated.scenario);
    this.vehicle = vehicleSchema.parse(structuredClone(vehicle));
    this.initialState = structuredClone(this.vehicle);
    this.runId = runId;
    this.log('armed', `场景 v${scenario.version} 已就绪；只运行一次，退出时不恢复设备状态`);
    this.evaluate();
  }

  private log(kind: EventKind, detail: string, capability?: Capability) {
    this.events.push({
      index: this.events.length,
      time: this.time,
      kind,
      detail,
      ...(capability ? { capability } : {}),
      state: structuredClone(this.vehicle),
    });
  }

  private matches(): boolean {
    const { signal, operator, threshold } = this.scenario.trigger;
    return operator === 'gt' ? this.vehicle[signal] > threshold : this.vehicle[signal] < threshold;
  }

  private stop(reason: string) {
    if (this.pending)
      this.log(
        'cancelled',
        `取消在途请求：${actionLabel(this.pending.action)}`,
        this.pending.action.capability,
      );
    this.pending = undefined;
    this.status = 'stopped';
    this.log('stopped', reason);
  }

  private evaluate() {
    if (isTerminal(this.status)) return;
    if (!isParked(this.vehicle)) {
      this.stop('停车条件失效（需要 P 挡且车速为 0）；取消后续动作，不恢复设备');
      return;
    }
    if (this.fired) {
      if (!this.matches()) this.stop('触发条件已失效；停止在途与后续动作');
      return;
    }
    if (!this.matches()) {
      if (this.conditionSince !== null) this.log('reset', '信号恢复，持续计时归零');
      this.conditionSince = null;
      return;
    }
    if (this.conditionSince === null) {
      this.conditionSince = this.time;
      this.log('condition', '触发条件满足，开始持续计时');
    }
    if (this.time - this.conditionSince >= this.scenario.trigger.holdSeconds) {
      this.fired = true;
      this.status = 'executing';
      this.log('triggered', `条件持续 ${this.scenario.trigger.holdSeconds} 秒，开始执行`);
      this.nextAction();
    }
  }

  private nextAction() {
    while (this.cursor < this.scenario.actions.length) {
      const action = this.scenario.actions[this.cursor++];
      const resource = resourceOf(action.capability);
      const needsPower = ['climate.temperature', 'climate.fan', 'climate.recirculation'].includes(
        action.capability,
      );
      if (!isParked(this.vehicle) || !this.matches()) {
        this.stop('动作前策略检查未通过');
        return;
      }
      if (this.locked.has(resource) || (needsPower && !this.vehicle.climatePower)) {
        this.failures++;
        this.log(
          'blocked',
          this.locked.has(resource)
            ? '用户已接管该设备，自动化让出控制'
            : '空调未开启，依赖条件未达成',
          action.capability,
        );
        continue;
      }
      this.pending = { action, acceptedAt: this.time };
      this.log('accepted', `请求已接受：${actionLabel(action)}；等待状态回读`, action.capability);
      return;
    }
    this.status = this.failures ? 'partial' : 'completed';
    this.log(
      'completed',
      this.failures
        ? `部分完成：${this.failures} 项未达成，请检查证据`
        : '全部动作状态已回读；本次场景结束',
    );
  }

  private apply(action: Action) {
    switch (action.capability) {
      case 'climate.power':
        this.vehicle.climatePower = action.value;
        break;
      case 'climate.temperature':
        this.vehicle.targetTemperature = action.value;
        break;
      case 'climate.fan':
        this.vehicle.fan = action.value;
        break;
      case 'climate.recirculation':
        this.vehicle.recirculation = action.value;
        break;
      case 'media.play':
        this.vehicle.track = action.value;
        this.vehicle.playing = true;
        break;
      case 'media.pause':
        this.vehicle.playing = false;
        break;
      case 'media.volume':
        this.vehicle.volume = action.value;
        break;
      case 'ambient.light':
        this.vehicle.light = action.value;
        break;
    }
  }

  step(seconds = 1) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
      throw new Error('单次推进范围为 1–600 秒');
    for (let i = 0; i < seconds && !isTerminal(this.status); i++) {
      this.time++;
      this.evaluate();
      if (this.status !== 'executing' || !this.pending) continue;
      const { action, acceptedAt } = this.pending;
      const elapsed = this.time - acceptedAt;
      if (this.fault === action.capability) {
        if (elapsed < this.scenario.timeoutSeconds) continue;
        this.failures++;
        this.log(
          'timeout',
          `服务超时：${actionLabel(action)}；未观测到状态达成`,
          action.capability,
        );
      } else {
        if (elapsed < 1) continue;
        this.apply(action);
        this.log('confirmed', `状态已达成：${actionLabel(action)}`, action.capability);
      }
      this.pending = undefined;
      this.nextAction();
    }
    return this.snapshot();
  }

  setSignals(
    patch: Partial<Pick<Vehicle, 'temperature' | 'illuminance' | 'co2' | 'gear' | 'speed'>>,
  ) {
    const allowed = z
      .object({
        temperature: vehicleSchema.shape.temperature.optional(),
        illuminance: vehicleSchema.shape.illuminance.optional(),
        co2: vehicleSchema.shape.co2.optional(),
        gear: vehicleSchema.shape.gear.optional(),
        speed: vehicleSchema.shape.speed.optional(),
      })
      .strict()
      .parse(patch);
    this.commands.push({ time: this.time, type: 'signals', patch: structuredClone(allowed) });
    this.vehicle = vehicleSchema.parse({ ...this.vehicle, ...allowed });
    this.log('input', `信号变化：${JSON.stringify(allowed)}`);
    this.evaluate();
    return this.snapshot();
  }

  manual(action: Action) {
    const validated = validateScenario({
      ...this.scenario,
      actions:
        action.capability.startsWith('climate.') && action.capability !== 'climate.power'
          ? [{ capability: 'climate.power', value: true }, action]
          : [action],
    });
    if (!validated.scenario) throw new Error('手动动作参数不合法');
    this.commands.push({ time: this.time, type: 'manual', action: structuredClone(action) });
    const resource = resourceOf(action.capability);
    this.locked.add(resource);
    this.apply(action);
    this.log(
      'manual',
      `用户手动操作：${actionLabel(action)}；本次运行不再控制该设备`,
      action.capability,
    );
    if (this.pending && resourceOf(this.pending.action.capability) === resource) {
      this.log('cancelled', '用户接管，取消在途动作', this.pending.action.capability);
      this.pending = undefined;
      this.failures++;
      this.nextAction();
    }
    return this.snapshot();
  }

  cancel() {
    if (isTerminal(this.status)) return this.snapshot();
    this.commands.push({ time: this.time, type: 'cancel' });
    if (this.pending)
      this.log('cancelled', '停止预演，取消在途请求', this.pending.action.capability);
    this.pending = undefined;
    this.status = 'cancelled';
    this.log('cancelled', '用户停止了本次运行；已完成的设备动作不回滚');
    return this.snapshot();
  }

  snapshot(): RunSnapshot {
    return structuredClone({
      schemaVersion: 1,
      runId: this.runId,
      scenario: this.scenario,
      initialState: this.initialState,
      fault: this.fault,
      status: this.status,
      time: this.time,
      vehicle: this.vehicle,
      events: this.events,
      commands: this.commands,
      progress: this.fired
        ? 1
        : Math.min(
            1,
            this.conditionSince === null
              ? 0
              : (this.time - this.conditionSince) / Math.max(1, this.scenario.trigger.holdSeconds),
          ),
      holdElapsed: this.conditionSince === null ? 0 : this.time - this.conditionSince,
      locked: [...this.locked],
      pending: this.pending?.action.capability,
      caveat: '仅表示当前虚拟车辆模型中的状态回读，不构成真车验收或安全认证。',
    });
  }
}

export function replayEvidence(evidence: RunEvidence): CabinRuntime {
  const runtime = new CabinRuntime(
    evidence.scenario,
    evidence.initialState,
    evidence.fault,
    `${evidence.runId}-replay`,
  );
  for (const command of evidence.commands) {
    const delta = command.time - runtime.snapshot().time;
    if (delta > 0) runtime.step(delta);
    if (command.type === 'signals') runtime.setSignals(command.patch);
    if (command.type === 'manual') runtime.manual(command.action);
    if (command.type === 'cancel') runtime.cancel();
  }
  const remaining = evidence.time - runtime.snapshot().time;
  if (remaining > 0) runtime.step(remaining);
  return runtime;
}
