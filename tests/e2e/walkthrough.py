#!/usr/bin/env python3
"""metric-demo 浏览器 E2E 走查（16 页签全覆盖，等价 README「第三层」清单的自动化版）

逐页签：导航 → 渲染断言（关键元素 / 行数 / 文本） → 核心交互冒烟 → 收集 JS 错误。
全部通过退出码 0；任一页失败退出码 1，并输出该页失败点。

用法：
    python tests/e2e/walkthrough.py                      # 无头 + 系统 Chrome
    python tests/e2e/walkthrough.py --headed             # 有头（可观察）
    python tests/e2e/walkthrough.py --exec-reimport      # 额外执行一次真实重导（写一条历史）
    PLAYWRIGHT_CHANNEL=chromium python tests/e2e/walkthrough.py   # 指定浏览器通道

前置：
    1) 服务已启动：backend/main.py（默认 http://127.0.0.1:8000，--base 可覆盖）
    2) 已 seed（overview.metrics > 0），脚本启动时会自动校验
依赖：playwright（.venv 已装）；浏览器优先用系统 Chrome，未安装时需 `playwright install chromium`
"""
import argparse
import os
import re
import sys

import httpx
from playwright.sync_api import sync_playwright

# 噪音控制台错误（favicon 404 等）——滤掉，其余计入页面 JS 错误
NOISE = re.compile(r"favicon|Failed to load resource|net::ERR_|DevTools", re.I)


# ---------------------------------------------------------------- 页面断言工具
def nav(page, tab_id):
    page.click(f'a.nav-item[data-tab="{tab_id}"]')
    page.wait_for_timeout(500)


def has(page, sel):
    return page.locator(sel).count() > 0


def rows(page, sel):
    return page.locator(sel + " tbody tr").count()


def text(page, sel):
    try:
        return page.locator(sel).first.inner_text()
    except Exception:
        return ""


def modal_open(page):
    cls = page.get_attribute("#modal-backdrop", "class") or ""
    return "open" in cls


def js_errors(page):
    """本页累积的 pageerror/console.error（滤噪音），并清空，返回致命错误列表"""
    bad = [str(m)[:220] for m in page.errors if not NOISE.search(str(m))]
    page.errors.clear()
    return bad


# ---------------------------------------------------------------- 各页签走查
def _walk_create_modal(page, f, btn_sel, tbl_sel, min_rows):
    """通用：列表行数 >= min_rows + 新建弹窗可打开可取消"""
    if rows(page, tbl_sel) < min_rows:
        f.append(f"{tbl_sel} 行数 < {min_rows}")
    page.click(btn_sel)
    page.wait_for_timeout(400)
    if not modal_open(page):
        f.append(f"{btn_sel} 新建弹窗未打开")
    page.click("#modal-cancel")
    page.wait_for_timeout(300)


def walk_processes(page, opts):
    f = []
    if rows(page, "#tbl-processes") < 1:
        f.append("#tbl-processes 行数 < 1")
    page.click("#btn-new-process")
    page.wait_for_timeout(400)
    if not modal_open(page):
        f.append("新建业务过程弹窗未打开")
    page.click("#modal-cancel")
    page.wait_for_timeout(300)
    # 字段管理弹窗：字段行 >= 1 + 「从物理表导入」按钮（字段管理器用关闭按钮关闭，无取消键）
    page.click('#tbl-processes tbody tr:first-child button[data-act="fields"]')
    page.wait_for_timeout(700)
    if not modal_open(page):
        f.append("过程字段管理弹窗未打开（按钮 data-act=fields）")
    else:
        if page.locator("#modal-body .attr-row").count() < 1:
            f.append("过程字段列表为空（seed 应带出各过程字段）")
        if not has(page, "#pf-sync"):
            f.append("「从物理表导入」按钮缺失")
        page.click("#modal-close")
        page.wait_for_timeout(300)
    return f


def walk_atomics(page, opts):
    f = []
    if rows(page, "#tbl-atomics") < 1:
        f.append("#tbl-atomics 行数 < 1")
    page.click("#btn-new-atomic")
    page.wait_for_timeout(400)
    if not modal_open(page):
        f.append("新建原子指标弹窗未打开")
        return f
    # 物理字段应为下拉且自动带出默认业务过程（order）的字段
    pf = page.locator("#f-physical_field")
    if pf.count() == 0:
        f.append("物理字段下拉缺失（应为 select 而非文本输入）")
    else:
        if pf.locator("option").count() < 1:
            f.append("物理字段下拉无选项（默认业务过程未定义字段）")
        if "（" not in pf.locator("option").first.inner_text():
            f.append("物理字段选项未带出「字段名（显示名 · 类型）」格式")
        # 切换业务过程（pay）→ 字段下拉应联动刷新
        pid = page.locator("#f-process_id")
        if pid.locator("option").count() >= 2:
            pid.select_option(index=1)
            page.wait_for_timeout(300)
            if pf.locator("option").count() < 1:
                f.append("切换业务过程后物理字段下拉未联动刷新")
    page.click("#modal-cancel")
    page.wait_for_timeout(300)
    return f


def walk_query(page, opts):
    f = []
    if rows(page, "#result-table") < 1:
        f.append("默认查询结果表无行（init 应自动执行默认查询）")
    if not has(page, "#chart svg"):
        f.append("图表 svg 缺失")
    if "SELECT" not in text(page, "#sql-preview"):
        f.append("SQL 预览未生成")
    # 交互：追加勾选「支付金额」→ 查询 → 结果列新增 pay_amount_sum
    page.click('#metric-chips label:has-text("支付金额")')
    page.wait_for_timeout(300)
    page.click("#btn-query")
    page.wait_for_timeout(1200)
    if "pay_amount_sum" not in text(page, "#result-table thead"):
        f.append("勾选「支付金额」后查询未生效（列缺 pay_amount_sum）")
    if not has(page, "#summary-cards .sum-card"):
        f.append("查询汇总卡未更新")
    return f


def walk_approvals(page, opts):
    f = []
    for v in ("pending", "history"):
        page.click(f'#approval-seg .seg-item[data-view="{v}"]')
        page.wait_for_timeout(500)
        if not has(page, "#tbl-approvals"):
            f.append(f"审批视图 {v} 表格缺失")
    return f


def walk_reimport(page, opts):
    f = []
    if not has(page, "#tbl-reimport-history"):
        f.append("重导历史记录卡缺失")
    else:
        n = rows(page, "#tbl-reimport-history")
        first_text = text(page, "#tbl-reimport-history tbody tr")
        if "暂无" in first_text:
            pass  # 空态：允许（未执行过重导）
        elif n == 0:
            f.append("重导历史未渲染（无空态提示）")
        elif "手动" not in first_text:
            f.append("重导历史首行触发方式应显示「手动」")
    page.click("#btn-reimport-history-refresh")
    page.wait_for_timeout(500)
    if opts.exec_reimport:
        page.select_option("#reimport-type", "logical_model")
        page.wait_for_timeout(300)
        page.select_option("#reimport-object", index=0)
        page.click("#btn-reimport-plan")
        page.wait_for_timeout(900)
        if rows(page, "#tbl-reimport-plan") < 1:
            f.append("重导执行计划未生成")
        else:
            # 计划行默认已勾选已物化模型；勿再点「全选」（会切换成全不选）
            before = rows(page, "#tbl-reimport-history")
            page.click("#btn-reimport-execute")
            try:
                page.wait_for_selector("#modal-backdrop.open", timeout=4000)
            except Exception:
                f.append("执行重导确认弹窗未出现")
                return f
            page.wait_for_timeout(400)
            page.click("#modal-ok")          # confirmModal 确认
            page.wait_for_timeout(2500)
            after = rows(page, "#tbl-reimport-history")
            if after <= before:
                f.append(f"执行重导后历史记录未增加（{before}→{after}）")
    return f


def walk_quality(page, opts):
    f = []
    if not has(page, "#tbl-health"):
        f.append("健康度总览表缺失")
    if not has(page, "#tbl-quality"):
        f.append("质量规则表缺失")
    page.click("#btn-health-refresh")
    page.wait_for_timeout(700)
    if not has(page, "#tbl-health"):
        f.append("健康度刷新后表格缺失")
    return f


def walk_ops(page, opts):
    f = []
    if not has(page, "#tbl-schedules"):
        f.append("调度表缺失")
    if not has(page, "#tbl-task-instances"):
        f.append("任务实例表缺失")
    page.click("#btn-ti-refresh")
    page.wait_for_timeout(500)
    return f


def walk_datasets(page, opts):
    f = []
    if rows(page, "#tbl-datasets") < 2:
        f.append("数据集应至少 2 条（物化直读 + 指标实时计算）")
    return f


def walk_openapi(page, opts):
    f = []
    if rows(page, "#tbl-apps") < 2:
        f.append("下游应用应至少 2 个")
    page.click("#btn-demo-call")
    page.wait_for_timeout(1200)
    if not text(page, "#demo-result-hint") and not text(page, "#demo-result"):
        f.append("调用演示未展示返回结果")
    return f


def walk_lineage(page, opts):
    f = []
    if not has(page, "#lineage-select"):
        f.append("指标血缘选择器缺失")
        return f
    page.select_option("#lineage-select", index=1)
    page.wait_for_timeout(900)
    g1 = text(page, "#lineage-graph")
    if "原子指标" not in g1:
        f.append("指标血缘图未渲染（缺「原子指标」层）")
    page.click("#lineage-view-switch .seg-item[data-view=table]")
    page.wait_for_timeout(900)
    g2 = text(page, "#lineage-graph")
    if "物化表" not in g2 and "下游模型" not in g2:
        f.append("表血缘图未渲染（缺物化表/下游模型层）")
    return f


# 16 页签清单：（data-tab, 页面标题, 走查函数）
PAGES = [
    ("query",        "统一指标查询", walk_query),
    ("domains",      "主题域",     lambda p, o: _walk_create_modal(p, [], "#btn-new-domain",     "#tbl-domains", 1)),
    ("processes",    "业务过程",   walk_processes),
    ("atomics",      "原子指标",   walk_atomics),
    ("dims",         "维度与维度属性", lambda p, o: _walk_create_modal(p, [], "#btn-new-dim",  "#tbl-dims", 3)),
    ("derived",      "派生指标",   lambda p, o: _walk_create_modal(p, [], "#btn-new-derived",    "#tbl-derived", 1)),
    ("composites",   "复合指标",   lambda p, o: _walk_create_modal(p, [], "#btn-new-composite",  "#tbl-composites", 1)),
    ("approvals",    "审批中心",   walk_approvals),
    ("models",       "逻辑模型",   lambda p, o: _walk_create_modal(p, [], "#btn-new-model",      "#tbl-models", 1)),
    ("downstreams",  "下游模型",   lambda p, o: _walk_create_modal(p, [], "#btn-new-downstream", "#tbl-downstreams", 1)),
    ("reimport",     "任务重导",   walk_reimport),
    ("quality",      "质量监控",   walk_quality),
    ("ops",          "任务运维",   walk_ops),
    ("datasets",     "数据集",     walk_datasets),
    ("openapi",      "开放 API",   walk_openapi),
    ("lineage",      "血缘追溯",   walk_lineage),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.environ.get("METRIC_DEMO_BASE", "http://127.0.0.1:8000"))
    ap.add_argument("--headed", action="store_true", help="带界面运行（默认无头）")
    ap.add_argument("--exec-reimport", action="store_true", help="额外执行一次真实重导（写库）")
    ap.add_argument("--screenshots", action="store_true", help="每页签失败时存截图到 tests/e2e/artifacts/")
    opts = ap.parse_args()

    # 前置检查：服务已启动 + 已 seed
    try:
        r = httpx.get(f"{opts.base}/api/v1/overview", timeout=5)
        r.raise_for_status()
        n_metrics = sum(r.json()["data"].get(k, 0) for k in ("atomic", "derived", "composite"))
        if n_metrics < 1:
            print("[前置检查失败] overview.metrics=0，请先运行 backend/seed.py 重建种子数据")
            sys.exit(1)
    except Exception as e:
        print(f"[前置检查失败] 服务未就绪？{e}")
        sys.exit(1)

    failed, ok = [], 0
    with sync_playwright() as p:
        browser, last_err = None, None
        for ch in (os.environ.get("PLAYWRIGHT_CHANNEL"), "chrome", None):
            try:
                browser = p.chromium.launch(headless=not opts.headed, channel=ch)
                break
            except Exception as e:
                last_err = e
        if browser is None:
            print(f"[启动失败] 无法启动浏览器：{last_err}\n提示：系统无 Chrome 时先执行 `.venv/bin/python -m playwright install chromium`（PLAYWRIGHT_CHANNEL=chromium 再跑）")
            sys.exit(1)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.errors = []
        page.on("pageerror", lambda e: page.errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: m.type == "error" and page.errors.append(f"console: {m.text}"))
        page.goto(opts.base)
        page.wait_for_timeout(1500)
        try:
            for tab_id, title, fn in PAGES:
                nav(page, tab_id)
                errs = []
                if title != page.locator("#page-title").inner_text():
                    errs.append(f"页签标题不符（期望 {title}）")
                errs += fn(page, opts) or []
                errs += [f"JS 错误: {e}" for e in js_errors(page)]
                if errs:
                    failed.append((tab_id, title, errs))
                    print(f"❌ {tab_id:12s} {title}")
                    for e in errs:
                        print(f"      - {e}")
                    if opts.screenshots:
                        from pathlib import Path
                        d = Path(__file__).resolve().parent / "artifacts"
                        d.mkdir(exist_ok=True)
                        page.screenshot(path=str(d / f"{tab_id}.png"))
                else:
                    ok += 1
                    print(f"✅ {tab_id:12s} {title}")
        finally:
            browser.close()

    print("-" * 56)
    if failed:
        print(f"E2E 走查失败：{len(failed)}/{len(PAGES)} 页签未通过")
        sys.exit(1)
    print(f"E2E 走查通过：{ok}/{len(PAGES)} 页签全部通过，无 JS 错误")


if __name__ == "__main__":
    main()