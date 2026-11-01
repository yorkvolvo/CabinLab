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
    assert page.locator(".check-item.passed").count() == 20
    passed("20 项产品基线验证通过")

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
    assert page.locator(".capability-card").count() == 8
    page.get_by_role("button", name="场景工作台", exact=True).click()
    passed("版本本地持久化、DSL 弹窗键盘关闭、8 项能力目录")

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(200)
    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
    page.screenshot(path=str(ARTIFACTS / "workbench-mobile.png"), full_page=True)
    page.get_by_role("button", name="运行全部验证", exact=True).click()
    expect(page.get_by_text("当前验证全部通过", exact=True)).to_be_visible()
    passed("390px 移动布局无横向溢出且验证交互可用")

    assert not errors, errors
    passed("浏览器无未捕获 JavaScript 异常")
    context.close()
    browser.close()

summary = {"passed": len(checks), "checks": checks, "browser": "Chromium", "viewports": ["1536×1150", "390×844"]}
(ARTIFACTS / "browser-verification.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))
