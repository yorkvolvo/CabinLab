"""对运行中的 CabinLab 做浏览器验收；产物保存在 artifacts/。"""

import json
import os
import re
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("CABINLAB_URL", "http://127.0.0.1:5173")
ARTIFACTS = Path("artifacts")
ARTIFACTS.mkdir(exist_ok=True)

for attempt in range(60):
    try:
        with urllib.request.urlopen(f"{BASE_URL}/api/health", timeout=1) as response:
            if response.status == 200:
                break
    except OSError:
        time.sleep(0.5)
else:
    raise RuntimeError(f"CabinLab 未启动：{BASE_URL}")

checks = []


def passed(name):
    checks.append(name)
    print(f"PASS {name}", flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1536, "height": 1150})
    page = context.new_page()
    errors = []
    page.add_init_script("""window.reminderTones = 0;
      const startTone = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (...args) {
        window.reminderTones++;
        return startTone.apply(this, args);
      };""")
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")
    expect(page.get_by_text("本地模板模式", exact=True)).to_be_visible()
    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
    page.screenshot(path=str(ARTIFACTS / "workbench-initial.png"), full_page=True)
    passed("桌面布局、中文工作台和演示模式标识")

    def select_template(name):
        page.locator(".scenario-nav").filter(has_text=name).click()
        expect(page.get_by_test_id("clock")).to_have_text("00:00")

    def steps(count):
        for _ in range(count):
            page.get_by_role("button", name="单步前进一秒", exact=True).click()

    def export_run(filename):
        with page.expect_download() as info:
            page.get_by_role("button", name="导出运行证据", exact=True).click()
        path = ARTIFACTS / filename
        info.value.save_as(path)
        return json.loads(path.read_text())

    page.get_by_role("button", name="运行全部验证", exact=True).click()
    expect(page.get_by_text("当前验证全部通过", exact=True)).to_be_visible()
    assert page.locator(".check-item.passed").count() == 22
    expect(page.locator(".verification .panel-heading")).to_contain_text("22 CHECKS")
    expect(page.locator(".toast")).to_contain_text("22 项验证全部通过")
    passed("22 项产品基线验证通过")

    compile_calls = []
    page.on("request", lambda request: compile_calls.append(request.url) if request.url.endswith("/api/compile") else None)
    page.get_by_role("button", name="生成场景", exact=True).evaluate("button => { button.click(); button.click(); }")
    expect(page.get_by_text("待确认草案", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="开始预演", exact=True)).to_be_disabled()
    assert len(compile_calls) == 1
    expect(page.get_by_text(re.compile("不会提取自定义数值"))).to_be_visible()
    page.get_by_role("button", name="确认参数并保存版本", exact=True).click()
    expect(page.get_by_label("场景版本", exact=True)).to_have_value("2")
    passed("重复生成只发一个请求，草案必须确认才能执行")

    page.get_by_role("button", name="开始预演", exact=True).click()
    page.wait_for_timeout(650)
    page.get_by_role("button", name="暂停", exact=True).click()
    paused = page.get_by_test_id("clock").inner_text()
    page.wait_for_timeout(650)
    expect(page.get_by_test_id("clock")).to_have_text(paused)
    elapsed = int(paused.split(":")[1])
    steps(14 - elapsed)
    expect(page.locator(".run-status")).to_contain_text("执行完成")
    successful = export_run("run-success.json")
    assert successful["vehicle"]["targetTemperature"] == 24
    assert successful["vehicle"]["playing"] is True
    assert len([e for e in successful["events"] if e["kind"] == "triggered"]) == 1
    page.screenshot(path=str(ARTIFACTS / "workbench-completed.png"), full_page=True)
    passed("开始、暂停、单步与四项状态回读")

    page.get_by_role("button", name="重放执行证据", exact=True).click()
    replayed = export_run("run-replay.json")
    assert replayed["events"] == successful["events"]
    assert replayed["vehicle"] == successful["vehicle"]
    passed("重放与原始证据一致")

    select_template("午间休憩")
    page.get_by_label("故障注入", exact=True).select_option("climate.temperature")
    steps(20)
    expect(page.locator(".run-status")).to_contain_text("部分完成")
    fault = export_run("run-timeout.json")
    assert fault["vehicle"]["targetTemperature"] == 26
    assert fault["vehicle"]["playing"] is True
    assert len([e for e in fault["events"] if e["kind"] == "timeout"]) == 1
    page.get_by_label("故障注入", exact=True).select_option("none")
    page.get_by_role("button", name="开始预演", exact=True).click()
    page.get_by_role("button", name="暂停", exact=True).click()
    steps(15)
    expect(page.locator(".run-status")).to_contain_text("执行完成")
    passed("温控超时呈现部分完成，故障恢复后能重新成功")

    select_template("午间休憩")
    page.get_by_label("故障注入", exact=True).select_option("climate.power:rejected")
    steps(20)
    expect(page.locator(".run-status")).to_contain_text("部分完成")
    rejected = export_run("run-rejected.json")
    assert len([e for e in rejected["events"] if e["kind"] == "rejected"]) == 1
    assert not [e for e in rejected["events"] if e.get("capability") == "climate.power" and e["kind"] == "accepted"]
    assert rejected["vehicle"]["playing"] is True
    passed("请求拒绝不冒充接受，空调依赖阻止而媒体继续")

    select_template("午间休憩")
    page.get_by_label("故障注入", exact=True).select_option("media.play:feedback-lost")
    steps(20)
    expect(page.locator(".run-status")).to_contain_text("结果待核实")
    expect(page.locator(".feedback-warning")).to_contain_text("最后已知状态")
    unknown = export_run("run-feedback-lost.json")
    assert unknown["runtimeVersion"] == "1.3.0"
    assert len([e for e in unknown["events"] if e["kind"] == "unknown"]) == 1
    assert not [e for e in unknown["events"] if e.get("capability") == "media.volume" and e["kind"] == "accepted"]
    page.get_by_role("button", name="重放执行证据", exact=True).click()
    assert export_run("run-feedback-lost-replay.json")["events"] == unknown["events"]
    page.screenshot(path=str(ARTIFACTS / "feedback-lost.png"), full_page=True)
    passed("回读丢失显示未知，停止同设备后续动作，重放保持未知")

    select_template("午间休憩")
    steps(11)
    page.get_by_role("button", name="手动设温 27°C", exact=True).click()
    steps(5)
    manual = export_run("run-manual.json")
    assert manual["vehicle"]["targetTemperature"] == 27
    assert manual["vehicle"]["playing"] is True
    assert "climate" in manual["locked"]
    passed("用户在请求回读前接管，温度不会被抢回")

    select_template("午间休憩")
    steps(10)
    page.get_by_role("button", name="切换到 D 挡", exact=True).click()
    expect(page.locator(".run-status")).to_contain_text("条件退出")
    stopped = export_run("run-motion.json")
    assert not [e for e in stopped["events"] if e["kind"] == "confirmed"]
    steps(2)
    expect(page.get_by_test_id("clock")).to_have_text("00:10")
    passed("行驶状态取消在途动作，终态单步不隐式重启")

    select_template("午间休憩")
    steps(10)
    page.get_by_role("button", name="停止预演", exact=True).click()
    stopped = export_run("run-cancelled.json")
    assert stopped["status"] == "cancelled"
    assert not [e for e in stopped["events"] if e["kind"] == "confirmed"]
    page.get_by_role("button", name="重放执行证据", exact=True).click()
    assert export_run("run-cancelled-replay.json")["events"] == stopped["events"]
    passed("停止在途请求与取消轨迹重放")

    select_template("午间休憩")
    page.get_by_label("持续时间", exact=True).fill("0")
    expect(page.get_by_role("button", name="开始预演", exact=True)).to_be_disabled()
    page.get_by_role("button", name="确认参数并保存版本", exact=True).click()
    expect(page.get_by_label("场景版本", exact=True)).to_have_value("3")
    page.get_by_role("button", name="运行全部验证", exact=True).click()
    expect(page.get_by_text("发现需要关注的行为", exact=True)).to_be_visible()
    assert page.locator(".check-item.failed").count() > 0
    jitter = page.locator(".check-item").filter(has_text="短时信号波动不能误触发")
    assert "failed" in jitter.get_attribute("class")
    jitter.locator("summary").click()
    expect(jitter).to_contain_text("短时波动已发出动作请求")
    with page.expect_download() as info:
        page.get_by_role("button", name="导出验证报告", exact=True).click()
    info.value.save_as(ARTIFACTS / "verification-regression.json")
    page.screenshot(path=str(ARTIFACTS / "verification-regression.png"), full_page=True)
    passed("10 秒改为 0 秒后，独立产品预期发现误触发")

    page.get_by_label("场景版本", exact=True).select_option("1")
    page.get_by_role("button", name="运行全部验证", exact=True).click()
    expect(page.get_by_text("当前验证全部通过", exact=True)).to_be_visible()
    page.get_by_role("button", name="开始预演", exact=True).click()
    select_template("静心阅读")
    page.wait_for_timeout(650)
    expect(page.get_by_test_id("clock")).to_have_text("00:00")
    steps(6)
    expect(page.locator(".run-status")).to_contain_text("执行完成")
    reading = export_run("run-reading.json")
    assert reading["vehicle"]["light"] == 60
    page.get_by_role("button", name="运行全部验证", exact=True).click()
    expect(page.get_by_text("当前验证全部通过", exact=True)).to_be_visible()
    select_template("清新座舱")
    steps(9)
    expect(page.locator(".run-status")).to_contain_text("执行完成")
    refresh = export_run("run-refresh.json")
    assert refresh["vehicle"]["fan"] == 3
    assert refresh["vehicle"]["recirculation"] is False
    page.get_by_role("button", name="运行全部验证", exact=True).click()
    expect(page.get_by_text("当前验证全部通过", exact=True)).to_be_visible()
    passed("版本回退恢复通过，运行中切换场景会停止旧时钟，三个模板均可运行")

    for name, expected in [
        ("低温暖舱", {"targetTemperature": 26, "fan": 2}),
        ("强力降温", {"targetTemperature": 22, "fan": 5, "recirculation": False}),
        ("夜间放松", {"light": 20, "track": "自然白噪音", "volume": 12}),
    ]:
        select_template(name)
        steps(12)
        expect(page.locator(".run-status")).to_contain_text("执行完成")
        run = export_run(f"run-{name}.json")
        assert all(run["vehicle"][key] == value for key, value in expected.items())
        page.get_by_role("button", name="运行全部验证", exact=True).click()
        expect(page.get_by_text("当前验证全部通过", exact=True)).to_be_visible()
        assert page.locator(".check-item.passed").count() == 22
    passed("新增暖舱、强力降温、夜间放松可预演，各通过 22 项固定基线")

    select_template("定时午休")
    steps(6)
    expect(page.locator(".run-status")).to_contain_text("等待提醒")
    expect(page.get_by_text("距离唤醒还有 1200 个虚拟秒", exact=True)).to_be_visible()
    assert page.evaluate("window.reminderTones") == 0
    page.get_by_role("button", name="快进到唤醒", exact=True).click()
    expect(page.get_by_role("alert")).to_have_text("午休时间到，请醒来")
    page.wait_for_function("window.reminderTones === 2")
    nap = export_run("run-nap.json")
    assert nap["time"] == 1206 and nap["vehicle"]["driverRecline"] == 25
    assert sum(event["kind"] == "reminder" for event in nap["events"]) == 1
    page.get_by_role("button", name="重放执行证据", exact=True).click()
    expect(page.get_by_role("alert")).to_have_text("午休时间到，请醒来")
    assert page.evaluate("window.reminderTones") == 2
    passed("定时午休准确唤醒，提示音只在预演播放，历史重放静音")

    select_template("充电等候")
    page.get_by_role("checkbox", name="已插枪充电").uncheck()
    page.get_by_role("checkbox", name="主驾有人").uncheck()
    page.get_by_role("checkbox", name="副驾有人").check()
    steps(3)
    expect(page.locator(".run-status")).to_contain_text("等待触发")
    page.get_by_role("checkbox", name="已插枪充电").check()
    steps(2)
    expect(page.locator(".run-status")).to_contain_text("等待提醒")
    slider = page.get_by_role("slider", name="模拟传感器数值")
    slider.fill("79")
    expect(page.get_by_role("alert")).to_have_count(0)
    slider.fill("80")
    expect(page.get_by_role("alert")).to_contain_text("电量已达到 80%")
    charge = export_run("run-charging.json")
    assert charge["vehicle"]["driverRecline"] == 0 and charge["vehicle"]["climatePower"]
    assert charge["status"] == "partial"
    assert not any(e["kind"] == "accepted" and e.get("capability") == "seat.recline" for e in charge["events"])
    select_template("充电等候")
    steps(3)
    page.get_by_role("checkbox", name="已插枪充电").uncheck()
    expect(page.locator(".run-status")).to_contain_text("条件退出")
    page.get_by_role("slider", name="模拟传感器数值").fill("100")
    expect(page.get_by_role("alert")).to_have_count(0)
    passed("充电等候守卫、空座不动、目标电量提醒和拔枪取消")

    select_template("雨天除雾")
    slider = page.get_by_role("slider", name="模拟传感器数值")
    slider.fill("1")
    steps(6)
    expect(page.locator(".run-status")).to_contain_text("等待触发")
    slider.fill("2")
    steps(6)
    expect(page.get_by_text("前挡除雾回读：已关闭", exact=True)).to_be_visible()
    steps(2)
    expect(page.get_by_text("前挡除雾回读：已开启", exact=True)).to_be_visible()
    rain = export_run("run-rain-defog.json")
    assert rain["status"] == "completed" and rain["vehicle"]["fan"] == 3
    assert rain["vehicle"]["frontDefrost"] is True
    page.get_by_role("button", name="重放执行证据", exact=True).click()
    expect(page.get_by_text("前挡除雾回读：已开启", exact=True)).to_be_visible()
    passed("雨量等级阈值、前挡除雾回读和证据重放")

    select_template("接娃等候")
    slider.fill("100")
    steps(6)
    expect(page.locator(".run-status")).to_contain_text("等待触发")
    slider.fill("99")
    steps(5)
    slider.fill("101")
    expect(page.locator(".run-status")).to_contain_text("条件退出")
    assert export_run("run-pickup-stopped.json")["vehicle"]["playing"] is True
    select_template("接娃等候")
    steps(8)
    pickup = export_run("run-pickup.json")
    assert pickup["status"] == "completed"
    assert pickup["vehicle"]["targetTemperature"] == 24 and not pickup["vehicle"]["playing"]
    passed("接娃点距离边界、离开范围取消及空调与媒体回读")

    migration_context = browser.new_context()
    old_versions = [
        {**successful["scenario"], "version": 7, "name": "我保存的午休"},
        reading["scenario"], refresh["scenario"],
    ]
    migration_context.add_init_script("localStorage.setItem('cabinlab.scenarios.v1', " + json.dumps(json.dumps(old_versions)) + ");")
    migration_page = migration_context.new_page()
    migration_page.goto(BASE_URL)
    expect(migration_page.get_by_label("场景版本", exact=True)).to_have_value("7")
    assert migration_page.locator(".scenario-nav").count() == 10
    expect(migration_page.locator(".workspace-toolbar")).to_contain_text("我保存的午休")
    migration_context.close()
    passed("旧三场景缓存保留自定义版本，自动补齐新增模板")

    select_template("午间休憩")
    pending_routes = []
    page.route("**/api/compile", lambda route: pending_routes.append(route))
    page.get_by_role("button", name="生成场景", exact=True).click()
    expect(page.get_by_role("button", name="取消生成", exact=True)).to_be_visible()
    page.get_by_role("button", name="取消生成", exact=True).click()
    expect(page.get_by_text("已取消生成，可以修改需求后重试。", exact=True)).to_be_visible()
    for route in pending_routes:
        try:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"mode": "demo", "draft": reading["scenario"], "message": "stale"}))
        except Exception:
            pass  # 浏览器可能已完成 AbortController 取消。
    expect(page.get_by_text("待确认草案", exact=True)).to_have_count(0)
    page.unroute("**/api/compile")
    page.get_by_role("button", name="生成场景", exact=True).click()
    expect(page.get_by_text("待确认草案", exact=True)).to_be_visible()
    page.get_by_role("button", name="放弃本次修改", exact=True).click()
    passed("生成可取消，晚到响应不会覆盖场景，取消后能重试")

    page.route("**/api/compile", lambda route: route.fulfill(status=502, content_type="application/json", body=json.dumps({"error": "测试：服务不可用，请重试"})))
    page.get_by_role("button", name="生成场景", exact=True).click()
    expect(page.get_by_text("测试：服务不可用，请重试", exact=True)).to_be_visible()
    expect(page.get_by_text("待确认草案", exact=True)).to_have_count(0)
    page.unroute("**/api/compile")
    passed("接口失败可见且不会生成可执行假结果")

    page.reload()
    page.wait_for_load_state("networkidle")
    expect(page.get_by_label("场景版本", exact=True)).to_have_value("3")
    page.get_by_label("场景版本", exact=True).select_option("1")
    page.get_by_role("button", name="查看场景 DSL", exact=True).click()
    expect(page.get_by_role("dialog", name="场景 DSL", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).to_have_count(0)
    page.get_by_role("button", name=re.compile("能力目录")).click()
    assert page.locator(".capability-card").count() == 10
    expect(page.get_by_text(re.compile("不能直接透传百分比"))).to_be_visible()
    expect(page.get_by_text(re.compile("阅读灯开关不能等同于亮度调节"))).to_be_visible()
    page.get_by_role("button", name="场景工作台", exact=True).click()
    passed("版本本地持久化、DSL 弹窗键盘关闭、10 项能力目录")

    for prompt in ["停车休息时不要开空调", "取消停车休息场景", "停车休息持续二十秒后开空调"]:
        page.get_by_label("自然语言需求", exact=True).fill(prompt)
        page.get_by_role("button", name="生成场景", exact=True).click()
        expect(page.get_by_role("alert")).to_be_visible()
        expect(page.get_by_text("待确认草案", exact=True)).to_have_count(0)
        expect(page.get_by_label("场景版本", exact=True)).to_have_value("1")
    passed("否定、取消和中文数值先澄清，不产生可执行草案或改写版本")

    page.get_by_role("button", name="修改当前场景", exact=True).click()
    page.get_by_label("自然语言需求", exact=True).fill("把持续时间改为 8 秒，目标温度设为 22°C")
    with page.expect_request("**/api/compile") as outgoing:
        page.get_by_role("button", name="生成修改草案", exact=True).click()
    body = outgoing.value.post_data_json
    assert body["intent"] == "modify" and body["baseScenario"]["version"] == 1
    expect(page.get_by_text("待确认草案", exact=True)).to_be_visible()
    expect(page.locator(".draft-diff")).to_contain_text("8 秒")
    expect(page.locator(".draft-diff")).to_contain_text("22°C")
    expect(page.get_by_role("button", name="开始预演", exact=True)).to_be_disabled()
    page.get_by_role("button", name="放弃本次修改", exact=True).click()
    expect(page.get_by_label("持续时间", exact=True)).to_have_value("10")
    expect(page.get_by_label("场景版本", exact=True)).to_have_value("1")
    passed("一句话修改携带当前版本，差异可核对，放弃不会改写基准")

    page.get_by_label("自然语言需求", exact=True).fill("把持续时间改为 0 秒")
    page.get_by_role("button", name="生成修改草案", exact=True).click()
    page.get_by_role("button", name="确认参数并保存版本", exact=True).click()
    expect(page.get_by_label("场景版本", exact=True)).to_have_value("4")
    page.locator(".version-comparison > summary").click()
    page.get_by_label("对照版本", exact=True).select_option("1")
    page.get_by_role("button", name="对照验证两个版本", exact=True).click()
    expect(page.get_by_text("新增失败 8 项", exact=True)).to_be_visible()
    expect(page.locator(".comparison-stats")).to_contain_text("v1：22/22")
    expect(page.locator(".comparison-stats")).to_contain_text("v4：14/22")
    with page.expect_download() as info:
        page.get_by_role("button", name="导出版本对照", exact=True).click()
    info.value.save_as(ARTIFACTS / "version-comparison.json")
    comparison = json.loads((ARTIFACTS / "version-comparison.json").read_text())
    assert comparison["regressions"] == 8 and comparison["contractVersion"] == "1.1"
    page.locator(".version-comparison").screenshot(path=str(ARTIFACTS / "version-comparison.png"))
    passed("版本对照报告 22→14 与 8 项回归，导出保留两版独立验证证据")

    page.get_by_label("场景版本", exact=True).select_option("1")
    page.get_by_label("自然语言需求", exact=True).fill("停车休息时打开车窗")
    page.get_by_role("button", name="生成场景", exact=True).click()
    expect(page.get_by_role("alert")).to_contain_text("能力目录之外")
    expect(page.get_by_text("待确认草案", exact=True)).to_have_count(0)
    page.get_by_role("button", name="修改当前场景", exact=True).click()
    page.get_by_label("自然语言需求", exact=True).fill("持续时间改为 5 秒，打开车窗")
    page.get_by_role("button", name="生成修改草案", exact=True).click()
    expect(page.get_by_role("alert")).to_contain_text("未应用任何部分")
    expect(page.get_by_label("持续时间", exact=True)).to_have_value("10")
    page.get_by_label("自然语言需求", exact=True).fill("持续时间改为 100 秒")
    page.get_by_role("button", name="生成修改草案", exact=True).click()
    expect(page.get_by_role("alert")).to_contain_text("超出允许范围")
    page.get_by_label("自然语言需求", exact=True).fill("持续时间改为 9 秒")
    page.get_by_role("button", name="生成修改草案", exact=True).click()
    expect(page.get_by_text("待确认草案", exact=True)).to_be_visible()
    page.get_by_role("button", name="放弃本次修改", exact=True).click()
    page.get_by_label("持续时间", exact=True).fill("61")
    expect(page.get_by_role("button", name="确认参数并保存版本", exact=True)).to_be_disabled()
    expect(page.get_by_role("alert")).to_contain_text("超出范围")
    page.get_by_role("button", name="放弃本次修改", exact=True).click()
    passed("不支持能力、混合指令和非法数值明确报错，修正后可以继续")

    page.get_by_role("button", name="创建场景", exact=True).click()
    pending_routes = []
    page.route("**/api/compile", lambda route: pending_routes.append(route))
    page.get_by_role("button", name="生成场景", exact=True).click()
    expect(page.get_by_role("button", name="取消生成", exact=True)).to_be_visible()
    page.get_by_label("自然语言需求", exact=True).fill("停车空气闷，使用外循环")
    for route in pending_routes:
        try:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"mode": "demo", "draft": reading["scenario"], "message": "旧响应不可覆盖"}))
        except Exception:
            pass
    expect(page.get_by_label("自然语言需求", exact=True)).to_have_value("停车空气闷，使用外循环")
    expect(page.get_by_text("待确认草案", exact=True)).to_have_count(0)
    expect(page.get_by_text("旧响应不可覆盖", exact=True)).to_have_count(0)
    page.unroute("**/api/compile")
    pending_routes = []
    page.route("**/api/compile", lambda route: pending_routes.append(route))
    page.get_by_role("button", name="生成场景", exact=True).click()
    expect(page.get_by_role("button", name="取消生成", exact=True)).to_be_visible()
    select_template("静心阅读")
    for route in pending_routes:
        try:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"mode": "demo", "draft": successful["scenario"], "message": "旧场景不可覆盖"}))
        except Exception:
            pass
    expect(page.locator(".workspace-toolbar")).to_contain_text("静心阅读")
    expect(page.get_by_text("待确认草案", exact=True)).to_have_count(0)
    page.unroute("**/api/compile")
    select_template("午间休憩")
    page.get_by_label("场景版本", exact=True).select_option("1")
    page.get_by_role("button", name="单步前进一秒", exact=True).evaluate("button => { button.click(); button.click(); }")
    expect(page.get_by_test_id("clock")).to_have_text("00:02")
    page.get_by_role("button", name="停止预演", exact=True).click()
    with page.expect_download() as info:
        page.get_by_role("button", name="导出实验", exact=True).click()
    info.value.save_as(ARTIFACTS / "experiment.json")
    passed("修改输入和切换场景取消旧请求，同一批双击单步不会重建运行")

    evidence_context = browser.new_context(viewport={"width": 1536, "height": 1150})
    evidence_page = evidence_context.new_page()
    evidence_page.on("pageerror", lambda error: errors.append(str(error)))
    evidence_page.goto(BASE_URL)
    evidence_page.wait_for_load_state("networkidle")
    evidence_page.get_by_role("button", name="单步前进一秒", exact=True).click()
    evidence_page.get_by_role("button", name="证据复核", exact=True).click()
    evidence_page.get_by_label("导入证据文件", exact=True).set_input_files(ARTIFACTS / "run-success.json")
    expect(evidence_page.get_by_text("重放一致性核验通过", exact=True)).to_be_visible()
    with evidence_page.expect_download() as info:
        evidence_page.get_by_role("button", name="导出复现证据", exact=True).click()
    info.value.save_as(ARTIFACTS / "import-replayed.json")
    imported = json.loads((ARTIFACTS / "import-replayed.json").read_text())
    assert imported["events"] == successful["events"] and imported["vehicle"] == successful["vehicle"]
    evidence_page.screenshot(path=str(ARTIFACTS / "evidence-inspector.png"), full_page=True)
    evidence_page.get_by_role("button", name="场景工作台", exact=True).click()
    expect(evidence_page.get_by_label("场景版本", exact=True)).to_have_value("1")
    expect(evidence_page.get_by_test_id("clock")).to_have_text("00:01")
    passed("新浏览器会话导入并独立重放，不覆盖当前版本和暂停中的运行")

    evidence_page.get_by_role("button", name="证据复核", exact=True).click()
    file_input = evidence_page.get_by_label("导入证据文件", exact=True)
    file_input.set_input_files(ARTIFACTS / "run-timeout.json")
    expect(evidence_page.get_by_text("重放一致性核验通过", exact=True)).to_be_visible()
    expect(evidence_page.locator(".evidence-result")).to_contain_text("原始运行结果：部分完成")
    file_input.set_input_files(ARTIFACTS / "run-feedback-lost.json")
    expect(evidence_page.get_by_text("重放一致性核验通过", exact=True)).to_be_visible()
    expect(evidence_page.locator(".evidence-result")).to_contain_text("原始运行结果：结果待核实")
    expect(evidence_page.locator(".evidence-result")).to_contain_text("不能据此认定动作未执行")
    passed("新会话独立核验未知结果，不把重放一致解释为动作成功")
    tampered = json.loads(json.dumps(successful))
    tampered["vehicle"]["targetTemperature"] = 23
    (ARTIFACTS / "run-tampered.json").write_text(json.dumps(tampered))
    file_input.set_input_files(ARTIFACTS / "run-tampered.json")
    expect(evidence_page.get_by_role("alert")).to_contain_text("重放与记录不一致")
    expect(evidence_page.get_by_text("重放一致性核验通过", exact=True)).to_have_count(0)
    legacy = {key: value for key, value in successful.items() if key != "runtimeVersion"}
    (ARTIFACTS / "run-legacy.json").write_text(json.dumps(legacy))
    file_input.set_input_files(ARTIFACTS / "run-legacy.json")
    expect(evidence_page.get_by_role("alert")).to_contain_text("运行时版本")
    file_input.set_input_files({"name": "oversized.json", "mimeType": "application/json", "buffer": b"x" * (1024 * 1024 + 1)})
    expect(evidence_page.get_by_role("alert")).to_contain_text("1 MB")
    file_input.set_input_files(ARTIFACTS / "run-success.json")
    expect(evidence_page.get_by_text("重放一致性核验通过", exact=True)).to_be_visible()
    file_input.set_input_files(ARTIFACTS / "experiment.json")
    expect(evidence_page.get_by_text("重放一致性核验通过", exact=True)).to_be_visible()
    expect(evidence_page.locator(".evidence-result")).to_contain_text("原始运行结果：已停止")
    passed("导入拒绝篡改、旧格式和超限文件；失败后可重试，完整实验可复现停止结果")
    evidence_context.close()

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(200)
    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
    assert page.locator(".scenario-nav").count() == 10
    nav_tops = page.locator(".nav-item").evaluate_all("items => items.map(item => item.getBoundingClientRect().top)")
    assert len(set(nav_tops)) == 1, nav_tops
    page.screenshot(path=str(ARTIFACTS / "workbench-mobile.png"), full_page=True)
    page.get_by_role("button", name="运行全部验证", exact=True).click()
    expect(page.get_by_text("当前验证全部通过", exact=True)).to_be_visible()
    passed("390px 移动布局无横向溢出且验证交互可用")

    page.locator(".version-comparison > summary").click()
    page.get_by_label("对照版本", exact=True).select_option("4")
    page.get_by_role("button", name="对照验证两个版本", exact=True).click()
    expect(page.get_by_text("恢复通过 8 项", exact=True)).to_be_visible()
    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
    page.get_by_role("button", name="证据复核", exact=True).click()
    page.get_by_label("导入证据文件", exact=True).set_input_files(ARTIFACTS / "run-timeout.json")
    expect(page.get_by_text("重放一致性核验通过", exact=True)).to_be_visible()
    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
    if page.get_by_role("button", name="关闭提示", exact=True).is_visible():
        page.get_by_role("button", name="关闭提示", exact=True).click()
    page.screenshot(path=str(ARTIFACTS / "evidence-mobile.png"), full_page=True)
    passed("390px 下版本对照与证据导入可操作，失败运行不会被解释成全部成功")

    assert not errors, errors
    passed("浏览器无未捕获 JavaScript 异常")
    context.close()
    browser.close()

summary = {"passed": len(checks), "checks": checks, "browser": "Chromium", "viewports": ["1536×1150", "390×844"]}
(ARTIFACTS / "browser-verification.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))
