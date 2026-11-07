import { z } from 'zod';
import {
  actionLabel,
  catalog,
  needsClimatePower,
  reminderLabel,
  seatLabels,
  signalLabels,
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
    charging: z.boolean().optional(),
    batteryPercent: z.number().min(0).max(100).optional(),
    driverOccupied: z.boolean().optional(),
    passengerOccupied: z.boolean().optional(),
    driverRecline: z.number().int().min(0).max(45).optional(),
    passengerRecline: z.number().int().min(0).max(45).optional(),
    rainLevel: z.number().int().min(0).max(3).optional(),
    pickupDistance: z.number().min(0).max(500).optional(),
    frontDefrost: z.boolean().optional(),
    driverDoorOpen: z.boolean().optional(),
    rearOccupied: z.boolean().optional(),
    windowPathClear: z.boolean().optional(),
    windowsClosed: z.boolean().optional(),
  })
  .strict();
export type Vehicle = z.infer<typeof vehicleSchema>;
export const signalsSchema = vehicleSchema
  .pick({
    temperature: true,
    illuminance: true,
    co2: true,
    gear: true,
    speed: true,
    charging: true,
    batteryPercent: true,
    driverOccupied: true,
    passengerOccupied: true,
    rainLevel: true,
    pickupDistance: true,
    driverDoorOpen: true,
    rearOccupied: true,
    windowPathClear: true,
  })
  .partial()
  .strict();
const reminderVehicleKeys = [
  'charging',
  'batteryPercent',
  'driverOccupied',
  'passengerOccupied',
  'driverRecline',
  'passengerRecline',
] as const;
const rainPickupVehicleKeys = ['rainLevel', 'pickupDistance', 'frontDefrost'] as const;
const departureWindowKeys = [
  'driverDoorOpen',
  'rearOccupied',
  'windowPathClear',
  'windowsClosed',
] as const;
export const faultSchema = z.enum([
  'none',
  ...Object.keys(catalog).flatMap((key) => {
    const capability = key as Capability;
    return [capability, `${capability}:rejected`, `${capability}:feedback-lost`] as const;
  }),
]);
export const runtimeVersionSchema = z.enum(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0']);
export type Fault = z.infer<typeof faultSchema>;
export type RunStatus =
  | 'armed'
  | 'executing'
  | 'waiting'
  | 'completed'
  | 'partial'
  | 'uncertain'
  | 'stopped'
  | 'cancelled';
export const runStatusLabels: Record<RunStatus, string> = {
  armed: '等待触发',
  executing: '正在执行',
  waiting: '等待提醒',
  completed: '执行完成',
  partial: '部分完成',
  uncertain: '结果待核实',
  stopped: '条件退出',
  cancelled: '已停止',
};
export type EventKind =
  | 'armed'
  | 'condition'
  | 'reset'
  | 'triggered'
  | 'accepted'
  | 'confirmed'
  | 'timeout'
  | 'rejected'
  | 'unknown'
  | 'blocked'
  | 'input'
  | 'manual'
  | 'cancelled'
  | 'stopped'
  | 'waiting'
  | 'reminder'
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
      patch: z.infer<typeof signalsSchema>;
    }
  | { time: number; type: 'manual'; action: Action }
  | { time: number; type: 'cancel' };
export interface RunEvidence {
  schemaVersion: 1;
  runtimeVersion: z.infer<typeof runtimeVersionSchema>;
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
  reminderDueAt?: number;
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

export function previewVehicle(scenario: Scenario): Vehicle {
  const { signal, threshold, operator } = scenario.trigger;
  const bounds = signalLabels[signal];
  const vehicle: Vehicle = {
    ...initialVehicle,
    ...(signal === 'driverExit'
      ? {}
      : {
          [signal]: Math.max(
            bounds.min,
            Math.min(bounds.max, threshold + (operator === 'gt' ? 2 : -2)),
          ),
        }),
  };
  if (
    scenario.reminder ||
    scenario.actions.some((action) => action.capability === 'seat.recline')
  ) {
    vehicle.driverOccupied = true;
    vehicle.passengerOccupied = false;
    vehicle.driverRecline = 0;
    vehicle.passengerRecline = 0;
  }
  if (scenario.reminder?.kind === 'charge') {
    vehicle.charging = true;
    vehicle.batteryPercent = Math.min(
      vehicle.batteryPercent ?? 60,
      Math.max(0, scenario.reminder.atPercent - 10),
    );
  }
  if (scenario.actions.some((action) => action.capability === 'climate.frontDefrost'))
    vehicle.frontDefrost = false;
  if (scenario.templateId === 'pickup' || scenario.templateId === 'passengerWait') {
    vehicle.playing = true;
    vehicle.track = '轻音乐';
  }
  if (scenario.templateId === 'passengerWait') {
    vehicle.driverOccupied = true;
    vehicle.driverDoorOpen = false;
    vehicle.passengerOccupied = true;
    vehicle.rearOccupied = false;
  }
  if (scenario.actions.some((action) => action.capability === 'window.close')) {
    vehicle.windowPathClear = true;
    vehicle.windowsClosed = false;
  }
  return vehicle;
}

export const isParked = (v: Vehicle) => v.gear === 'P' && v.speed === 0;
export const isTerminal = (status: RunStatus) =>
  !['armed', 'executing', 'waiting'].includes(status);

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
  private uncertain = new Set<Resource>();
  private reminderDueAt?: number;
  private departure: 'unseen' | 'seated' | 'doorOpen' | 'exited' = 'unseen';

  constructor(
    scenario: Scenario,
    vehicle: Vehicle = initialVehicle,
    private readonly fault: Fault = 'none',
    runId = 'local-run',
    private readonly runtimeVersion: RunEvidence['runtimeVersion'] = '1.4.0',
  ) {
    faultSchema.parse(fault);
    runtimeVersionSchema.parse(runtimeVersion);
    if (runtimeVersion === '1.0.0' && fault.includes(':'))
      throw new Error('旧运行时不支持请求拒绝或回读丢失故障');
    const validated = validateScenario(scenario);
    if (!validated.scenario) throw new Error(validated.errors.join('；'));
    if (!validated.scenario.confirmed) throw new Error('请先确认场景参数与退出策略');
    this.scenario = structuredClone(validated.scenario);
    this.vehicle = vehicleSchema.parse(structuredClone(vehicle));
    if (
      !this.supportsReminders &&
      (this.scenario.reminder ||
        this.scenario.trigger.signal === 'batteryPercent' ||
        this.scenario.actions.some((action) => action.capability === 'seat.recline') ||
        reminderVehicleKeys.some((key) => this.vehicle[key] !== undefined) ||
        fault.startsWith('seat.'))
    )
      throw new Error('旧运行时不支持座椅、充电和定时提醒');
    if (
      !this.supportsRainPickup &&
      (this.scenario.trigger.signal === 'rainLevel' ||
        this.scenario.trigger.signal === 'pickupDistance' ||
        this.scenario.actions.some((action) => action.capability === 'climate.frontDefrost') ||
        rainPickupVehicleKeys.some((key) => this.vehicle[key] !== undefined) ||
        fault.startsWith('climate.frontDefrost'))
    )
      throw new Error('旧运行时不支持雨量、接娃距离和前挡除雾');
    if (
      runtimeVersion !== '1.4.0' &&
      (this.scenario.templateId === 'rainClose' ||
        this.scenario.trigger.signal === 'driverExit' ||
        this.scenario.actions.some((action) => action.capability === 'window.close') ||
        departureWindowKeys.some((key) => this.vehicle[key] !== undefined) ||
        fault.startsWith('window.'))
    )
      throw new Error('旧运行时不支持主驾离车或车窗关闭');
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

  private get supportsReminders(): boolean {
    return this.runtimeVersion !== '1.0.0' && this.runtimeVersion !== '1.1.0';
  }

  private get supportsRainPickup(): boolean {
    return this.runtimeVersion === '1.3.0' || this.runtimeVersion === '1.4.0';
  }

  private observeDeparture() {
    const { driverOccupied, driverDoorOpen, passengerOccupied, rearOccupied } = this.vehicle;
    const passengerPresent = passengerOccupied === true || rearOccupied === true;
    if (driverOccupied === true && driverDoorOpen === false) this.departure = 'seated';
    else if (driverDoorOpen === true && this.departure === 'seated') this.departure = 'doorOpen';
    else if (driverDoorOpen === false && this.departure === 'doorOpen')
      this.departure = driverOccupied === false && passengerPresent ? 'exited' : 'unseen';
    else if (this.departure === 'seated') this.departure = 'unseen';
    else if (
      this.departure === 'exited' &&
      (driverOccupied !== false || driverDoorOpen !== false || !passengerPresent)
    )
      this.departure = 'unseen';
  }

  private matches(): boolean {
    const { signal, operator, threshold } = this.scenario.trigger;
    if (signal === 'driverExit') return this.departure === 'exited';
    const value = this.vehicle[signal];
    return value !== undefined && (operator === 'gt' ? value > threshold : value < threshold);
  }

  private seatAvailable(action: Action): boolean {
    return (
      action.capability !== 'seat.recline' ||
      (action.seat === 'driver' ? this.vehicle.driverOccupied : this.vehicle.passengerOccupied) ===
        true
    );
  }

  private stop(reason: string) {
    if (this.pending)
      this.log(
        'cancelled',
        `取消在途请求：${actionLabel(this.pending.action)}`,
        this.pending.action.capability,
      );
    this.pending = undefined;
    this.reminderDueAt = undefined;
    this.status = 'stopped';
    this.log('stopped', reason);
  }

  private evaluate() {
    if (isTerminal(this.status)) return;
    if (!isParked(this.vehicle)) {
      this.stop('停车条件失效（需要 P 挡且车速为 0）；取消后续动作，不恢复设备');
      return;
    }
    if (this.scenario.trigger.signal === 'driverExit') this.observeDeparture();
    if (this.scenario.reminder?.kind === 'charge' && this.vehicle.charging !== true) {
      if (this.fired) this.stop('充电已断开；取消后续动作与电量提醒');
      else if (this.conditionSince !== null) {
        this.conditionSince = null;
        this.log('reset', '未在充电；持续计时归零');
      }
      return;
    }
    if (this.status === 'waiting') {
      this.checkReminder();
      return;
    }
    if (this.fired) {
      if (!this.scenario.reminder && !this.matches()) {
        this.stop('触发条件已失效；停止在途与后续动作');
        return;
      }
      if (this.pending && !this.seatAvailable(this.pending.action)) {
        this.log('cancelled', '座位占用失效；取消在途座椅动作', this.pending.action.capability);
        this.pending = undefined;
        this.failures++;
        this.nextAction();
      }
      if (
        this.pending?.action.capability === 'window.close' &&
        this.vehicle.windowPathClear !== true
      ) {
        this.log('cancelled', '窗路出现障碍或状态未知，取消在途关窗', 'window.close');
        this.pending = undefined;
        this.failures++;
        this.nextAction();
      }
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
      const needsPower = needsClimatePower(action.capability);
      if (!isParked(this.vehicle) || (!this.scenario.reminder && !this.matches())) {
        this.stop('动作前策略检查未通过');
        return;
      }
      if (action.capability === 'seat.recline' && !this.seatAvailable(action)) {
        this.failures++;
        this.log(
          'blocked',
          `${seatLabels[action.seat]}未确认有人；禁止座椅动作`,
          action.capability,
        );
        continue;
      }
      if (action.capability === 'window.close' && this.vehicle.windowPathClear !== true) {
        this.failures++;
        this.log('blocked', '窗路有障碍或状态未知，禁止关闭车窗', action.capability);
        continue;
      }
      if (
        this.locked.has(resource) ||
        this.uncertain.has(resource) ||
        (needsPower && !this.vehicle.climatePower)
      ) {
        this.failures++;
        this.log(
          'blocked',
          this.locked.has(resource)
            ? '用户已接管该设备，自动化让出控制'
            : this.uncertain.has(resource)
              ? '该设备有结果未知的请求，停止后续控制，等待人工核实'
              : '空调未开启，依赖条件未达成',
          action.capability,
        );
        continue;
      }
      if (this.fault === `${action.capability}:rejected`) {
        this.failures++;
        this.log(
          'rejected',
          `请求被拒绝：${actionLabel(action)}；未接受、未执行`,
          action.capability,
        );
        continue;
      }
      this.pending = { action, acceptedAt: this.time };
      this.log('accepted', `请求已接受：${actionLabel(action)}；等待状态回读`, action.capability);
      return;
    }
    const reminder = this.scenario.reminder;
    if (reminder) {
      this.status = 'waiting';
      if (reminder.kind === 'wake') this.reminderDueAt = this.time + reminder.afterSeconds;
      this.log('waiting', reminderLabel(reminder));
      this.checkReminder();
    } else this.finish();
  }

  private checkReminder() {
    const reminder = this.scenario.reminder;
    if (!reminder) return;
    if (reminder.kind === 'wake' && this.vehicle.driverOccupied !== true) {
      this.stop('主驾未确认有人；取消定时唤醒');
      return;
    }
    const due =
      reminder.kind === 'wake'
        ? this.time >= (this.reminderDueAt ?? Infinity)
        : this.vehicle.batteryPercent !== undefined &&
          this.vehicle.batteryPercent >= reminder.atPercent;
    if (!due) return;
    this.log(
      'reminder',
      reminder.kind === 'wake'
        ? '午休时间到，请醒来'
        : `电量已达到 ${reminder.atPercent}%，请查看充电状态`,
    );
    this.reminderDueAt = undefined;
    this.finish();
  }

  private finish() {
    this.status = this.uncertain.size ? 'uncertain' : this.failures ? 'partial' : 'completed';
    this.log(
      'completed',
      this.uncertain.size
        ? '存在结果未知的请求；可能已执行，不自动重试，请核实设备状态'
        : this.failures
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
      case 'climate.frontDefrost':
        this.vehicle.frontDefrost = action.value;
        break;
      case 'media.play':
        this.vehicle.track = action.value;
        this.vehicle.playing = true;
        break;
      case 'media.pause':
        this.vehicle.playing = false;
        break;
      case 'window.close':
        this.vehicle.windowsClosed = true;
        break;
      case 'media.volume':
        this.vehicle.volume = action.value;
        break;
      case 'ambient.light':
        this.vehicle.light = action.value;
        break;
      case 'seat.recline':
        this.vehicle[action.seat === 'driver' ? 'driverRecline' : 'passengerRecline'] =
          action.value;
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
      const feedbackLost = this.fault === `${action.capability}:feedback-lost`;
      if (this.fault === action.capability || feedbackLost) {
        if (elapsed < this.scenario.timeoutSeconds) continue;
        this.failures++;
        if (feedbackLost) this.uncertain.add(resourceOf(action.capability));
        this.log(
          feedbackLost ? 'unknown' : 'timeout',
          feedbackLost
            ? `回读丢失：${actionLabel(action)}；结果未知，可能已执行；保留最后已知状态，不自动重试`
            : `服务超时：${actionLabel(action)}；未观测到状态达成`,
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

  advanceTo(target: number) {
    if (!Number.isInteger(target) || target < 0 || target > this.time + 3600)
      throw new Error('目标虚拟时间不合法');
    while (this.time < target && !isTerminal(this.status))
      this.step(Math.min(600, target - this.time));
    return this.snapshot();
  }

  setSignals(patch: z.infer<typeof signalsSchema>) {
    const allowed = signalsSchema.parse(patch);
    if (
      (!this.supportsReminders && reminderVehicleKeys.some((key) => key in allowed)) ||
      (!this.supportsRainPickup && rainPickupVehicleKeys.some((key) => key in allowed)) ||
      (this.runtimeVersion !== '1.4.0' && departureWindowKeys.some((key) => key in allowed))
    )
      throw new Error('旧运行时不支持此信号');
    this.commands.push({ time: this.time, type: 'signals', patch: structuredClone(allowed) });
    this.vehicle = vehicleSchema.parse({ ...this.vehicle, ...allowed });
    this.log('input', `信号变化：${JSON.stringify(allowed)}`);
    this.evaluate();
    return this.snapshot();
  }

  manual(action: Action) {
    const validated = validateScenario({
      ...this.scenario,
      actions: needsClimatePower(action.capability)
        ? [{ capability: 'climate.power', value: true }, action]
        : [action],
    });
    if (!validated.scenario) throw new Error('手动动作参数不合法');
    if (
      action.capability === 'seat.recline' &&
      (!this.supportsReminders || !isParked(this.vehicle) || !this.seatAvailable(action))
    )
      throw new Error('必须停车且对应座位有人，才允许座椅动作');
    if (action.capability === 'climate.frontDefrost' && !this.supportsRainPickup)
      throw new Error('旧运行时不支持前挡除雾');
    if (
      action.capability === 'window.close' &&
      (this.runtimeVersion !== '1.4.0' ||
        !isParked(this.vehicle) ||
        this.vehicle.windowPathClear !== true)
    )
      throw new Error('必须停车且确认窗路无障碍，才允许关闭车窗');
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
    this.reminderDueAt = undefined;
    this.status = 'cancelled';
    this.log('cancelled', '用户停止了本次运行；已完成的设备动作不回滚');
    return this.snapshot();
  }

  snapshot(): RunSnapshot {
    return structuredClone({
      schemaVersion: 1,
      runtimeVersion: this.runtimeVersion,
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
      ...(this.reminderDueAt === undefined ? {} : { reminderDueAt: this.reminderDueAt }),
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
    evidence.runtimeVersion,
  );
  for (const command of evidence.commands) {
    runtime.advanceTo(command.time);
    if (command.type === 'signals') runtime.setSignals(command.patch);
    if (command.type === 'manual') runtime.manual(command.action);
    if (command.type === 'cancel') runtime.cancel();
  }
  runtime.advanceTo(evidence.time);
  return runtime;
}
