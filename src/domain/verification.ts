import { CabinRuntime, previewVehicle, replayEvidence, type RunSnapshot } from './runtime';
import { cloneTemplate } from './templates';
import { resourceOf, signalLabels, validateScenario, type Action, type Scenario } from './scenario';

export interface VerificationCase {
  id: string;
  name: string;
  group: string;
  passed: boolean;
  detail: string;
  evidence?: RunSnapshot;
}
export interface VerificationReport {
  scenario: Scenario;
  contractVersion: '1.1';
  baseline: string;
  passed: number;
  total: number;
  cases: VerificationCase[];
}

const expect = (condition: unknown, detail: string) => {
  if (!condition) throw new Error(detail);
};
const count = (s: RunSnapshot, kind: string) => s.events.filter((e) => e.kind === kind).length;
const actionsMatch = (s: RunSnapshot, action: Action) => {
  const v = s.vehicle;
  switch (action.capability) {
    case 'climate.power':
      return v.climatePower === action.value;
    case 'climate.temperature':
      return v.targetTemperature === action.value;
    case 'climate.fan':
      return v.fan === action.value;
    case 'climate.recirculation':
      return v.recirculation === action.value;
    case 'climate.frontDefrost':
      return v.frontDefrost === action.value;
    case 'media.play':
      return v.playing && v.track === action.value;
    case 'media.pause':
      return !v.playing;
    case 'window.close':
      return v.windowsClosed === true;
    case 'mirror.heat':
      return v.mirrorHeat === action.value;
    case 'media.volume':
      return v.volume === action.value;
    case 'ambient.light':
      return v.light === action.value;
    case 'seat.recline':
      return (action.seat === 'driver' ? v.driverRecline : v.passengerRecline) === action.value;
  }
};

// 产品基线独立于被测版本；修改场景不会改写期望。
export function verifyScenario(scenario: Scenario): VerificationReport {
  const baseline = cloneTemplate(scenario.templateId);
  const hold = baseline.trigger.holdSeconds;
  const signal = baseline.trigger.signal;
  const bounds = signalLabels[signal];
  const inactive = Math.max(
    bounds.min,
    Math.min(
      bounds.max,
      baseline.trigger.threshold + (baseline.trigger.operator === 'gt' ? -2 : 2),
    ),
  );
  const initial = previewVehicle(baseline);
  const cases: VerificationCase[] = [];
  let latest: CabinRuntime | undefined;
  const create = (v = initial) => {
    latest = new CabinRuntime(scenario, v);
    return latest;
  };
  const evidence = () => latest?.snapshot();
  const test = (id: string, name: string, group: string, run: () => string) => {
    latest = undefined;
    try {
      const detail = run();
      cases.push({ id, name, group, passed: true, detail, evidence: evidence() });
    } catch (e) {
      cases.push({
        id,
        name,
        group,
        passed: false,
        detail: e instanceof Error ? e.message : '未知验证错误',
        evidence: evidence(),
      });
    }
  };

  if (signal === 'driverExit') {
    const depart = (run: CabinRuntime) => {
      run.setSignals({ driverDoorOpen: true });
      run.setSignals({ driverOccupied: false });
      run.setSignals({ driverDoorOpen: false });
    };
    test('departure', '开门离座并关门后才开始计时', '触发边界', () => {
      const r = create();
      expect(count(r.step(10), 'accepted') === 0, '主驾仍在车内');
      depart(r);
      expect(count(r.step(hold - 1), 'accepted') === 0, '离车后过早触发');
      const s = r.step(1 + baseline.actions.length);
      expect(
        s.status === 'completed' && baseline.actions.every((action) => actionsMatch(s, action)),
        '空调或媒体未达到预期',
      );
      expect(
        JSON.stringify(replayEvidence(s).snapshot().events) === JSON.stringify(s.events),
        '重放不一致',
      );
      return '满足完整条件后回读空调与媒体，离车顺序可重放';
    });
    test('rear', '副驾为空且后排有人时可以等候', '占用守卫', () => {
      const r = create({ ...initial, passengerOccupied: false, rearOccupied: true });
      depart(r);
      expect(r.step(30).status === 'completed', '后排占用未生效');
      return '后排明确有人即可触发';
    });
    test('absent', '初始无人或只离座均不触发', '离车守卫', () => {
      const absent = create({ ...initial, driverOccupied: false });
      depart(absent);
      expect(count(absent.step(30), 'accepted') === 0, '未观察到主驾在座');
      const seated = create();
      seated.setSignals({ driverOccupied: false });
      expect(count(seated.step(30), 'accepted') === 0, '仅离座不代表离车');
      depart(seated);
      expect(count(seated.step(30), 'accepted') === 0, '早先离座不应与后续开门拼成离车');
      return '预演需要完整离车输入';
    });
    test('empty', '乘客占用未知或空舱时不触发', '占用守卫', () => {
      const r = create({ ...initial, passengerOccupied: undefined, rearOccupied: false });
      depart(r);
      r.setSignals({ rearOccupied: true });
      expect(count(r.step(30), 'accepted') === 0, '未在离车时确认仍有乘客');
      return '乘客后来上车需要重新观察一次离车';
    });
    test('exit', '主驾返回、乘客离开或驶离时取消在途动作', '运行守卫', () => {
      for (const change of [
        { driverOccupied: true },
        { passengerOccupied: false },
        { gear: 'D' },
      ] as const) {
        const r = create();
        depart(r);
        expect(count(r.step(hold), 'accepted') === 1, '在途请求前提未满足');
        const s = r.setSignals(change);
        expect(s.status === 'stopped' && count(s, 'confirmed') === 0, '条件退出后仍有动作达成');
      }
      return '动作回读前复查离车、占用和停车状态';
    });
    return {
      scenario: structuredClone(scenario),
      contractVersion: '1.1',
      baseline: `${baseline.name} · 固定离车基线 v1`,
      passed: cases.filter((c) => c.passed).length,
      total: cases.length,
      cases,
    };
  }

  const reminder = baseline.reminder;
  if (reminder?.kind === 'pet') {
    const countAlerts = (s: RunSnapshot) => count(s, 'reminder');
    const monitor = (run = create()) => {
      run.setSignals({ petPresent: true });
      run.step(hold + baseline.actions.length);
      return run;
    };
    test('presence', '确认宠物在舱后才准备空调', '触发边界', () => {
      const r = create();
      expect(count(r.step(10), 'accepted') === 0, '未确认宠物在舱就发出动作');
      const s = monitor(r).snapshot();
      expect(
        s.status === 'waiting' && baseline.actions.every((a) => actionsMatch(s, a)),
        '准备动作未达到基线',
      );
      return '确认后才启动并进入监测';
    });
    test('temperature', '温度达到阈值提醒一次且可重放', '监测', () => {
      const r = monitor();
      expect(
        countAlerts(r.setSignals({ temperature: reminder.maxTemperature - 1 })) === 0,
        '温度未到阈值就提醒',
      );
      const s = r.setSignals({ temperature: reminder.maxTemperature });
      expect(countAlerts(s) === 1 && countAlerts(r.step(10)) === 1, '未在阈值提醒或重复提醒');
      expect(s.status === 'waiting', '提醒后监测已结束');
      expect(
        JSON.stringify(replayEvidence(s).snapshot().events) === JSON.stringify(s.events),
        '重放不一致',
      );
      return '温度边界和提醒可重放';
    });
    test('monitor-after-warning', '持续异常只提醒一次，恢复后可重新提醒', '监测', () => {
      const r = monitor();
      r.setSignals({ temperature: reminder.maxTemperature });
      const battery = r.setSignals({ batteryPercent: reminder.minBatteryPercent });
      expect(battery.status === 'waiting' && countAlerts(battery) === 2, '新增低电量未单独提醒');
      expect(
        battery.events.filter((e) => e.kind === 'reminder').at(-1)?.detail ===
          `宠物留舱提醒：电量降至 ${reminder.minBatteryPercent}%`,
        '重复报告了持续高温',
      );
      const recovered = r.setSignals({
        temperature: reminder.maxTemperature - 1,
        batteryPercent: reminder.minBatteryPercent + 1,
      });
      expect(recovered.petWarnings?.length === 0, '恢复后仍显示异常');
      const again = r.setSignals({ temperature: reminder.maxTemperature });
      expect(again.status === 'waiting' && countAlerts(again) === 3, '恢复后再次异常未重新提醒');
      return '异常分开去重，恢复清除当前状态，历史仍可复核';
    });
    test('battery', '低电量或电量未知时提醒', '监测', () => {
      const r = monitor();
      expect(
        countAlerts(r.setSignals({ batteryPercent: reminder.minBatteryPercent + 1 })) === 0,
        '电量未到阈值就提醒',
      );
      expect(
        countAlerts(r.setSignals({ batteryPercent: reminder.minBatteryPercent })) === 1,
        '低电量未提醒',
      );
      const s = monitor(create({ ...initial, batteryPercent: undefined })).snapshot();
      expect(
        s.events.some((e) => e.kind === 'reminder' && e.detail.includes('电量未知')),
        '未知电量未提醒',
      );
      return '包含等于阈值和未知状态';
    });
    test('climate-failure', '空调回读丢失时提醒', '故障', () => {
      latest = new CabinRuntime(scenario, initial, 'climate.power:feedback-lost');
      latest.setSignals({ petPresent: true });
      const s = latest.step(60);
      expect(
        s.status === 'waiting' && count(s, 'unknown') === 1 && countAlerts(s) === 1,
        '空调未知未提醒或监测已停止',
      );
      return '空调未确认时提示一次，监测继续';
    });
    test('exit', '离舱或驶离后结束监测', '运行守卫', () => {
      for (const patch of [{ petPresent: false }, { gear: 'D' }] as const) {
        const r = monitor();
        const s = r.setSignals(patch);
        expect(s.status === 'stopped' && countAlerts(s) === 0, '退出时监测未停止');
      }
      return '停车和在舱状态贯穿监测';
    });
    return {
      scenario: structuredClone(scenario),
      contractVersion: '1.1',
      baseline: `${baseline.name} · 固定监测基线 v1`,
      passed: cases.filter((c) => c.passed).length,
      total: cases.length,
      cases,
    };
  }

  if (signal === 'petPresent') throw new Error('宠物监测基线缺少提醒');
  const active = initial[signal]!;
  if (reminder) {
    const readyTime = hold + baseline.actions.length;
    const atDue = (run: CabinRuntime) =>
      reminder.kind === 'wake'
        ? run.advanceTo(readyTime + reminder.afterSeconds)
        : run.setSignals({ batteryPercent: reminder.atPercent });
    test('preparation', '准备动作达到固定状态，提醒尚未触发', '准备与提醒', () => {
      const s = create().advanceTo(readyTime);
      expect(s.status === 'waiting', '准备完成后未进入提醒等待');
      expect(
        baseline.actions.every((action) => actionsMatch(s, action)),
        '准备动作与产品基线不符',
      );
      expect(count(s, 'reminder') === 0, '提醒提前触发');
      return '座椅和舒适动作已回读，提醒独立等待';
    });
    test('boundary', '只在固定计时或目标电量边界提醒', '准备与提醒', () => {
      const r = create();
      r.advanceTo(readyTime);
      const before =
        reminder.kind === 'wake'
          ? r.advanceTo(readyTime + reminder.afterSeconds - 1)
          : r.setSignals({ batteryPercent: reminder.atPercent - 1 });
      expect(count(before, 'reminder') === 0, '尚未达到固定边界就提醒');
      const after = atDue(r);
      expect(
        count(after, 'reminder') === 1 && after.status === 'completed',
        '达到固定边界未完成一次提醒',
      );
      return '恰好达到时间或电量边界时提醒';
    });
    test('once', '后续信号与时间推进不重复提醒', '准备与提醒', () => {
      const r = create();
      r.advanceTo(readyTime);
      expect(count(atDue(r), 'reminder') === 1, '未触发首个提醒');
      r.step(10);
      const after = r.setSignals({ batteryPercent: 100 });
      expect(count(after, 'reminder') === 1, '提醒重复触发');
      return '一次预演最多发出一次提醒';
    });
    test('restore-settings', '提醒后恢复已经改变的设置', '退出恢复', () => {
      const r = create();
      r.advanceTo(readyTime);
      const s = atDue(r);
      expect(
        s.vehicle.driverRecline === initial.driverRecline &&
          s.vehicle.climatePower === initial.climatePower &&
          s.vehicle.targetTemperature === initial.targetTemperature &&
          s.vehicle.track === initial.track &&
          s.vehicle.playing === initial.playing &&
          s.events.some((event) => event.kind === 'restored'),
        '结束后仍保留场景改过的设置',
      );
      return '在停车条件满足时恢复预演开始前的设置';
    });
    test('empty-seat', '主驾空置时不发送座椅请求', '占用守卫', () => {
      const s = create({ ...initial, driverOccupied: false, passengerOccupied: true }).advanceTo(
        readyTime,
      );
      expect(
        !s.events.some((event) => event.kind === 'accepted' && event.capability === 'seat.recline'),
        '空置主驾收到座椅请求',
      );
      expect(
        s.vehicle.driverRecline === 0 &&
          s.events.some(
            (event) =>
              event.kind === 'confirmed' &&
              event.capability === 'climate.power' &&
              event.state.climatePower,
          ),
        '空置座椅改变或独立空调动作未继续',
      );
      return '副驾有人不能替代主驾占用，其他动作可继续';
    });
    test('seat-loss', '座椅请求后离座，取消在途动作', '占用守卫', () => {
      const r = create();
      expect(r.advanceTo(hold).pending === 'seat.recline', '未进入座椅在途状态');
      r.setSignals({ driverOccupied: false });
      const s = r.advanceTo(readyTime + 10);
      expect(s.vehicle.driverRecline === 0 && count(s, 'cancelled') > 0, '离座后未取消座椅动作');
      return '回读前重新检查占用，无迟到动作';
    });
    test(
      'interrupt',
      reminder.kind === 'wake' ? '离座取消唤醒' : '拔枪取消提醒',
      '退出守卫',
      () => {
        const r = create();
        expect(r.advanceTo(readyTime).status === 'waiting', '未进入等待提醒状态');
        r.setSignals(reminder.kind === 'wake' ? { driverOccupied: false } : { charging: false });
        const s = atDue(r);
        expect(s.status === 'stopped' && count(s, 'reminder') === 0, '失效后仍然提醒');
        return '条件退出清除等待，不回滚已完成动作';
      },
    );
    test('park', '驶离取消等待中的提醒', '退出守卫', () => {
      const r = create();
      r.advanceTo(readyTime);
      r.setSignals({ gear: 'D' });
      const s = atDue(r);
      expect(s.status === 'stopped' && count(s, 'reminder') === 0, '驶离后仍然提醒');
      return '停车守卫贯穿等待阶段';
    });
    test('cancel', '手动停止不会留下提醒', '退出守卫', () => {
      const r = create();
      r.advanceTo(readyTime);
      r.cancel();
      const s = atDue(r);
      expect(
        s.status === 'cancelled' && count(s, 'reminder') === 0 && s.reminderDueAt === undefined,
        '停止后仍保留提醒',
      );
      return '停止清除计时，后续输入不重启';
    });
    test('replay', '提醒与输入轨迹独立重放一致', '证据', () => {
      const r = create();
      r.advanceTo(readyTime);
      const s = atDue(r);
      const replayed = replayEvidence(s).snapshot();
      expect(
        count(s, 'reminder') === 1 && JSON.stringify(s.events) === JSON.stringify(replayed.events),
        '提醒轨迹未一致重放',
      );
      return '虚拟时间、座椅回读与提醒均可复现';
    });
    if (reminder.kind === 'charge')
      test('plug', '未插枪等待，接通后才执行', '退出守卫', () => {
        const r = create({ ...initial, charging: false });
        expect(count(r.step(10), 'accepted') === 0, '未插枪就发出准备动作');
        expect(count(r.setSignals({ charging: true }), 'accepted') === 1, '接通后没有开始准备');
        return '插枪为显式模拟输入，缺失或断开不执行';
      });
    return {
      scenario: structuredClone(scenario),
      contractVersion: '1.1',
      baseline: `${baseline.name} · 固定提醒基线 v1`,
      passed: cases.filter((c) => c.passed).length,
      total: cases.length,
      cases,
    };
  }

  test('normal', '持续满足后，所有目标状态达成', '正常路径', () => {
    const s = create().step(90);
    expect(s.status === 'completed', `预期全部完成，实际 ${s.status}`);
    expect(
      baseline.actions.every((a) => actionsMatch(s, a)),
      '设备状态与已确认产品基线不同',
    );
    return '全部动作回读值符合模板产品基线';
  });
  test('duration', `满 ${hold} 秒前不发出任何请求`, '触发边界', () => {
    const r = create();
    const s = r.step(hold - 1);
    expect(count(s, 'accepted') === 0, `未到 ${hold} 秒就出现动作请求，存在提前触发`);
    expect(count(r.step(), 'triggered') === 1, '到达约定持续时间后应触发一次');
    return '持续时间边界符合独立基线';
  });
  test('jitter', '短时信号波动不能误触发', '触发边界', () => {
    const r = create();
    r.step(1);
    r.setSignals({ [signal]: inactive });
    const s = r.step(30);
    expect(count(s, 'accepted') === 0, '短时波动已发出动作请求；建议恢复模板持续时间');
    return '1 秒波动后恢复，未产生动作请求';
  });
  test('equal', '等于阈值时不触发', '触发边界', () => {
    const s = create({ ...initial, [signal]: baseline.trigger.threshold }).step(90);
    expect(count(s, 'triggered') === 0, '等于阈值不应触发');
    return '严格大于 / 小于边界通过';
  });
  test('reset', '条件中断后重新计算持续时间', '触发边界', () => {
    const r = create();
    r.step(hold - 1);
    r.setSignals({ [signal]: inactive });
    r.step();
    r.setSignals({ [signal]: active });
    const s = r.step(hold - 1);
    expect(count(s, 'accepted') === 0, '计时未重置，或过早触发');
    expect(count(r.step(), 'triggered') === 1, '重新满足完整持续时间后未触发');
    return '不累加中断前时间';
  });
  test('gear', 'D 挡时阻止所有自动动作', '运行守卫', () => {
    const s = create({ ...initial, gear: 'D' }).step(60);
    expect(count(s, 'accepted') === 0, '非 P 挡仍发出了请求');
    return '非 P 挡，运行被停止';
  });
  test('speed', 'P 挡但车速非零仍要阻止', '运行守卫', () => {
    const s = create({ ...initial, speed: 1 }).step(60);
    expect(count(s, 'accepted') === 0, '车速非零仍发出了请求');
    return '挡位与速度同时参与守卫';
  });
  test('motion', '请求接受后，挡位变化取消在途动作', '运行守卫', () => {
    const r = create();
    const before = r.step(hold);
    expect(count(before, 'accepted') === 1, '在途请求前提未满足');
    r.setSignals({ gear: 'D' });
    const s = r.step(30);
    expect(count(s, 'confirmed') === 0 && s.status === 'stopped', '行驶后在途动作仍达成');
    return '接受不等于完成；状态回读前再次检查';
  });
  test('condition-loss', '执行期间触发条件失效则停止', '运行守卫', () => {
    const r = create();
    r.step(hold);
    r.setSignals({ [signal]: inactive });
    const s = r.step(30);
    expect(s.status === 'stopped' && count(s, 'confirmed') === 0, '条件失效后仍完成动作');
    return '在途与剩余动作已停止';
  });
  test('once', '持续满足也只运行一次', '执行语义', () => {
    const r = create();
    r.step(90);
    const s = r.step(90);
    expect(
      count(s, 'triggered') === 1 && count(s, 'accepted') === baseline.actions.length,
      '发生重复触发或动作数量不符',
    );
    return '单次会话不会重复执行';
  });
  test('accepted', '请求接受与状态达成分开记录', '执行语义', () => {
    const s = create().step(hold);
    expect(count(s, 'accepted') === 1 && count(s, 'confirmed') === 0, '请求与状态回读未分开');
    return '接受后需等待下一秒的状态回读';
  });
  test('cancel-armed', '触发前停止不产生动作', '停止与重放', () => {
    const r = create();
    r.cancel();
    const s = r.step(90);
    expect(s.status === 'cancelled' && count(s, 'accepted') === 0, '停止后仍有动作请求');
    return '等待中的运行可取消';
  });
  test('cancel-pending', '停止后在途请求不能再完成', '停止与重放', () => {
    const r = create();
    r.step(hold);
    r.cancel();
    const s = r.step(90);
    expect(count(s, 'confirmed') === 0 && s.status === 'cancelled', '取消后出现状态达成');
    return '在途请求被取消';
  });
  test('no-rollback', '退出保留已完成的设备状态', '停止与重放', () => {
    const r = create();
    r.step(hold + 1);
    const before = r.snapshot().vehicle;
    r.setSignals({ gear: 'D' });
    const s = r.step(30);
    expect(
      JSON.stringify({ ...s.vehicle, gear: 'P' }) === JSON.stringify(before),
      '退出时恢复了用户未要求恢复的状态',
    );
    return '只停止后续动作，无隐式回滚';
  });
  test('timeout', '服务超时不能报告全部成功', '异常与接管', () => {
    latest = new CabinRuntime(scenario, initial, baseline.actions[0].capability);
    const s = latest.step(90);
    expect(count(s, 'timeout') === 1 && s.status === 'partial', '超时没有产生部分完成状态');
    expect(
      !s.events.some(
        (e) => e.kind === 'confirmed' && e.capability === baseline.actions[0].capability,
      ),
      '超时动作被错误标记达成',
    );
    return '超时记录与状态回读明确区分';
  });
  test('independent', '故障后只继续独立动作', '异常与接管', () => {
    latest = new CabinRuntime(scenario, initial, baseline.actions[0].capability);
    const s = latest.step(90);
    const firstResource = resourceOf(baseline.actions[0].capability);
    const independent = baseline.actions.filter((a) => resourceOf(a.capability) !== firstResource);
    expect(count(s, 'timeout') === 1, '故障注入前提未满足');
    expect(
      independent.every((a) => actionsMatch(s, a)),
      '独立动作没有继续执行',
    );
    if (firstResource === 'climate')
      expect(
        !s.events.some((e) => e.kind === 'confirmed' && e.capability?.startsWith('climate.')),
        '空调开启失败后仍执行了依赖动作',
      );
    return '独立动作继续，依赖动作被阻止';
  });
  test('request-rejected', '请求拒绝不能冒充接受或达成', '异常与接管', () => {
    const capability = baseline.actions[0].capability;
    latest = new CabinRuntime(scenario, initial, `${capability}:rejected`);
    const s = latest.step(90);
    expect(count(s, 'rejected') === 1 && s.status === 'partial', '拒绝结果未正确记录');
    expect(
      !s.events.some(
        (event) =>
          event.capability === capability && ['accepted', 'confirmed'].includes(event.kind),
      ),
      '被拒绝的动作不应被标记为已接受或已达成',
    );
    return '拒绝与执行超时分开记录，不自动重试';
  });
  test('feedback-lost', '回读丢失标记未知并让出该设备', '异常与接管', () => {
    const capability = baseline.actions[0].capability;
    latest = new CabinRuntime(scenario, initial, `${capability}:feedback-lost`);
    const s = latest.step(90);
    const resource = resourceOf(capability);
    expect(count(s, 'unknown') === 1 && s.status === 'uncertain', '缺少未知结果终态');
    expect(
      s.events.filter(
        (event) => event.kind === 'accepted' && resourceOf(event.capability!) === resource,
      ).length === 1,
      '结果未知后重试或继续控制了同一设备',
    );
    expect(
      baseline.actions
        .filter((action) => resourceOf(action.capability) !== resource)
        .every((action) => actionsMatch(s, action)),
      '结果未知后未继续独立设备动作',
    );
    expect(
      !s.events.some((event) => event.kind === 'confirmed' && event.capability === capability),
      '丢失回读被误标为状态达成',
    );
    return '保留最后已知状态，不推断未执行；同一设备停止控制，独立动作继续';
  });
  test('manual', '手动操作取得设备控制权', '异常与接管', () => {
    const r = create();
    r.step(hold);
    const first = baseline.actions[0].capability;
    const manual: Action =
      resourceOf(first) === 'ambient'
        ? { capability: 'ambient.light', value: 25 }
        : first === 'window.close'
          ? { capability: 'window.close', value: true }
          : first === 'mirror.heat'
            ? { capability: 'mirror.heat', value: false }
            : { capability: 'climate.temperature', value: 27 };
    r.manual(manual);
    const s = r.step(90);
    expect(actionsMatch(s, manual), '自动化覆盖了用户手动设定');
    expect(s.locked.includes(resourceOf(first)), '设备未被标记为手动接管');
    return '在途动作取消，自动化不抢回该设备';
  });
  test('replay', '相同输入重放得到相同执行证据', '停止与重放', () => {
    const r = create();
    r.step(1);
    r.setSignals({ [signal]: inactive });
    r.step(1);
    r.setSignals({ [signal]: active });
    const s = r.step(90);
    const replay = replayEvidence(s).snapshot();
    expect(JSON.stringify(s.events) === JSON.stringify(replay.events), '重放事件不一致');
    expect(JSON.stringify(s.vehicle) === JSON.stringify(replay.vehicle), '重放终态不一致');
    return '初始状态、虚拟时钟与输入轨迹可复现';
  });
  test('whitelist', '未知能力不能进入执行器', '能力边界', () => {
    const invalid = validateScenario({
      ...scenario,
      actions: [{ capability: 'vehicle.drive', value: true }],
    });
    expect(!invalid.scenario, '未拦截不在目录中的能力');
    return '不生成或执行任意代码、驾驶控制';
  });
  test('confirmation', '未确认的候选场景禁止执行', '能力边界', () => {
    let rejected = false;
    try {
      new CabinRuntime({ ...scenario, confirmed: false });
    } catch {
      rejected = true;
    }
    expect(rejected, '未经确认的场景被执行');
    return '确认是执行前置条件';
  });
  return {
    scenario: structuredClone(scenario),
    contractVersion: '1.1',
    baseline: `${baseline.name} · 模板产品基线 v1（期望不会随场景修改）`,
    passed: cases.filter((c) => c.passed).length,
    total: cases.length,
    cases,
  };
}
