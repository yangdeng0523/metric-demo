/* 统一指标维度管理平台 Demo — 前端逻辑
   覆盖：统一指标查询（动态 SQL + 图表 + Excel 导出）/ 全量元数据 CRUD /
   派生规则引擎（筛选条件构建器）/ 逻辑模型 JOIN 配置 / 血缘追溯 */
const API = "/api/v1";

const TYPE_LABEL = { atomic: "原子指标", derived: "派生指标", composite: "复合指标" };
const PERIOD_LABEL = { "1d": "最近1天", "7d": "最近7天", "30d": "最近30天", "90d": "最近90天", ytd: "年初至今", custom: "自定义" };
const GRANULARITY_LABEL = { day: "日", week: "周", month: "月" };
const STATUS_LABEL = { DRAFT: "草稿", PUBLISHED: "已发布", ARCHIVED: "已归档" };
const FILTER_OPS = ["=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN", "BETWEEN", "LIKE"];
const AGG_FUNCTIONS = ["SUM", "COUNT", "AVG", "MAX", "MIN", "COUNT_DISTINCT"];
const JOIN_TYPES = ["SINGLE", "JOIN"];
const CHART_COLORS = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d"];
const ENTITY_TYPE_LABEL = { atomic_metric: "原子指标", derived_metric: "派生指标", composite_metric: "复合指标", dimension: "维度", logical_model: "逻辑模型", downstream_model: "下游模型" };
const VERSION_CHANGE_LABEL = { update: "编辑", status: "状态变更", approve: "审批发布", rollback: "回滚" };
const RULE_TYPE_LABEL = { row_count_min: "行数下限", row_count_change: "行数波动", non_null_rate: "非空率", fresh_days: "新鲜度" };
const RULE_TYPE_PARAMS = {
  row_count_min: [{ key: "min_rows", label: "行数下限", type: "number", placeholder: "如 100" }],
  row_count_change: [{ key: "max_change_pct", label: "波动阈值 %", type: "number", placeholder: "如 20" }],
  non_null_rate: [{ key: "column", label: "校验列", type: "text", placeholder: "如 order_amount_sum" }, { key: "min_rate", label: "非空率阈值 %", type: "number", placeholder: "如 95" }],
  fresh_days: [{ key: "max_days", label: "最大天数", type: "number", placeholder: "如 7" }],
};
const TASK_TYPE_LABEL = { materialize: "物化", reimport: "重导", quality_check: "质量检查" };
const TRIGGER_LABEL = { manual: "手动", schedule: "调度", auto: "自动" };
const TASK_STATUS_LABEL = { PENDING: "待执行", RUNNING: "运行中", SUCCESS: "成功", FAILED: "失败", SKIPPED: "跳过" };
const APPROVAL_STATUS_LABEL = { PENDING: "待审批", APPROVED: "已同意", REJECTED: "已驳回" };
const ALERT_LEVEL_LABEL = { info: "提示", warning: "警告", error: "错误" };
const HEALTH_LABEL = { green: "健康", yellow: "关注", red: "告警" };

// 全局状态（缓存，变更后刷新）
let META = { atomic: [], derived: [], composite: [] };
let DIMS = [];
let DOMAINS = [];
let PROCESSES = [];
let PHYSICAL_TABLES = [];
let LOGICAL_MODELS = [];
let DOWNSTREAMS = [];
let APPS = [];
let DATASETS = [];
let CURRENT_TAB = "query";
let LINEAGE_VIEW = "metric";
let LAST_QUERY = null;
const APP_SECRETS = {};  // 会话内缓存：仅创建/重置时拿到明文 AppSecret

// ---------------------------------------------------------------- 工具函数
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(v) {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") {
    return v.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
  }
  return v;
}
function toast(msg, ok = true) {
  const t = document.createElement("div");
  t.className = "toast " + (ok ? "ok" : "err");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function copyText(text, label = "已复制") {
  navigator.clipboard?.writeText(text)
    .then(() => toast(label))
    .catch(() => toast("复制失败", false));
}

// 统一响应解包：{code, message, data} → data；非 0 抛出 message
async function api(path, opts) {
  let r;
  try {
    r = await fetch(API + path, opts);
  } catch {
    throw new Error("网络错误：无法连接后端服务");
  }
  let body = null;
  try { body = await r.json(); } catch { /* noop */ }
  if (!r.ok || (body && body.code !== 0)) {
    throw new Error(body && body.message ? body.message : `请求失败 (${r.status})`);
  }
  return body ? body.data : null;
}
function post(path, data) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
function put(path, data) {
  return api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
const del = path => api(path, { method: "DELETE" });

// ---------------------------------------------------------------- 弹窗框架
// fields: [{key, label, type, required, placeholder, options, span, hint}]
// type: text/textarea/number/date/select/multi(checkbox 组)/dims/filters/joins/status/pre(code)
let _modalResolve = null;

function openModal({ title, fields = [], value = {}, width = 560, hint = "", onOk }) {
  $("modal-title").textContent = title;
  $("modal").style.width = width + "px";
  $("modal-msg").textContent = "";
  $("modal-ok").style.display = "";          // 恢复（SQL 预览弹窗曾隐藏）
  $("modal-cancel").textContent = "取 消";
  $("modal-cancel").onclick = closeModal;
  const body = $("modal-body");
  body.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "form-grid";
  for (const f of fields) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    if (f.span) wrap.style.gridColumn = "span " + f.span;
    const lab = document.createElement("label");
    lab.textContent = f.label + (f.required ? " *" : "");
    wrap.appendChild(lab);
    const v = value[f.key] ?? f.default ?? "";
    switch (f.type) {
      case "textarea": {
        const ta = document.createElement("textarea");
        ta.rows = 3; ta.id = "f-" + f.key;
        ta.placeholder = f.placeholder || "";
        ta.value = Array.isArray(v) ? JSON.stringify(v) : v;
        ta.style.cssText = "width:100%;border:1px solid var(--border-strong);border-radius:8px;padding:8px 12px;font-size:13px;font-family:monospace";
        wrap.appendChild(ta);
        break;
      }
      case "select": {
        const sel = document.createElement("select");
        sel.id = "f-" + f.key;
        for (const o of (typeof f.options === "function" ? f.options() : f.options || [])) {
          const op = document.createElement("option");
          op.value = o.value; op.textContent = o.label;
          sel.appendChild(op);
        }
        if (v !== "" && v !== null && v !== undefined) sel.value = v;
        wrap.appendChild(sel);
        break;
      }
      case "multi": {
        // 多选：checkbox 组
        const box = document.createElement("div");
        box.className = "chip-group";
        box.id = "f-" + f.key;
        for (const o of (typeof f.options === "function" ? f.options() : f.options || [])) {
          const lab2 = document.createElement("label");
          lab2.className = "chip" + ((value[f.key] || []).includes(o.value) ? " active" : "");
          lab2.innerHTML = `<input type="checkbox" value="${esc(o.value)}" ${(value[f.key] || []).includes(o.value) ? "checked" : ""}>${esc(o.label)}`;
          lab2.querySelector("input").onchange = () => lab2.classList.toggle("active", lab2.querySelector("input").checked);
          box.appendChild(lab2);
        }
        wrap.appendChild(box);
        break;
      }
      case "filters": { // 派生指标筛选条件构建器（业务限定）
        const box = document.createElement("div");
        box.id = "f-" + f.key;
        wrap.appendChild(box);
        const add = () => {
          const row = document.createElement("div");
          row.className = "filter-row";
          const i1 = document.createElement("input"); i1.placeholder = "字段，如 pay_amount";
          i1.className = "fr-field";
          const i2 = document.createElement("select");
          i2.className = "fr-op";
          i2.innerHTML = FILTER_OPS.map(o => `<option>${o}</option>`).join("");
          const i3 = document.createElement("input"); i3.placeholder = "值（IN/BETWEEN 用逗号分隔）";
          i3.className = "fr-val";
          const bt = document.createElement("button");
          bt.className = "btn-ghost fr-del"; bt.textContent = "移除";
          row.append(i1, i2, i3, bt);
          bt.onclick = () => row.remove();
          box.appendChild(row);
        };
        for (const fl of (value[f.key] || [])) {
          add();
          const last = box.lastElementChild;
          last.querySelector(".fr-field").value = fl.field || "";
          last.querySelector(".fr-op").value = fl.op || "=";
          last.querySelector(".fr-val").value = Array.isArray(fl.value) ? fl.value.join(",") : fl.value;
        }
        const plus = document.createElement("button");
        plus.className = "btn-ghost"; plus.textContent = "+ 添加筛选条件";
        plus.onclick = add;
        wrap.appendChild(plus);
        break;
      }
      case "joins": { // 逻辑模型 JOIN 配置
        const box = document.createElement("div");
        box.id = "f-" + f.key;
        wrap.appendChild(box);
        const add = (j = {}) => {
          const row = document.createElement("div");
          row.className = "join-row";
          const i1 = document.createElement("input"); i1.placeholder = "关联表，如 dim_city";
          i1.className = "jr-table"; i1.value = j.table || "";
          const i2 = document.createElement("input"); i2.placeholder = "别名，如 d0";
          i2.className = "jr-alias"; i2.value = j.alias || "";
          const i3 = document.createElement("input"); i3.placeholder = "ON 条件，如 t.city_id = d0.city_id";
          i3.className = "jr-on"; i3.value = j.on || "";
          i3.style.flex = "2";
          const bt = document.createElement("button");
          bt.className = "btn-ghost jr-del"; bt.textContent = "移除";
          bt.onclick = () => row.remove();
          row.append(i1, i2, i3, bt);
          box.appendChild(row);
        };
        (value[f.key] || []).forEach(add);
        const plus = document.createElement("button");
        plus.className = "btn-ghost"; plus.textContent = "+ 添加 JOIN 表";
        plus.onclick = () => add();
        wrap.appendChild(plus);
        break;
      }
      case "status": {
        const sel = document.createElement("select");
        sel.id = "f-" + f.key;
        sel.innerHTML = ["DRAFT", "PUBLISHED", "ARCHIVED"].map(s =>
          `<option ${v === s ? "selected" : ""}>${s}</option>`).join("");
        wrap.appendChild(sel);
        break;
      }
      case "pre": {
        const pre = document.createElement("pre");
        pre.className = "form-pre";
        pre.textContent = v || "（无）";
        wrap.appendChild(pre);
        break;
      }
      case "tags": { // 标签输入：chips + 回车添加
        const box = document.createElement("div");
        box.className = "tag-input";
        box.id = "f-" + f.key;
        const tags = [...new Set((value[f.key] || []).map(String).filter(Boolean))];
        const render = () => {
          box.innerHTML = "";
          for (const t of tags) {
            const c = document.createElement("span");
            c.className = "chip-tag";
            c.innerHTML = `${esc(t)}<b class="tag-x" data-t="${esc(t)}">×</b>`;
            c.querySelector(".tag-x").onclick = () => { tags.splice(tags.indexOf(t), 1); render(); };
            box.appendChild(c);
          }
          const inp = document.createElement("input");
          inp.className = "tag-input-in";
          inp.placeholder = f.placeholder || "回车添加标签";
          inp.onkeydown = e => {
            if (e.key === "Enter") {
              e.preventDefault();
              const v = inp.value.trim();
              if (v && !tags.includes(v)) { tags.push(v); render(); }
            } else if (e.key === "Backspace" && !inp.value && tags.length) {
              tags.pop(); render();
            }
          };
          box.appendChild(inp);
        };
        render();
        wrap.appendChild(box);
        break;
      }
      default: {
        const inp = document.createElement("input");
        inp.type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
        inp.id = "f-" + f.key;
        inp.placeholder = f.placeholder || "";
        inp.value = v;
        wrap.appendChild(inp);
      }
    }
    if (f.hint) {
      const hi = document.createElement("div");
      hi.className = "hint-text"; hi.style.marginTop = "5px";
      hi.textContent = f.hint;
      wrap.appendChild(hi);
    }
    grid.appendChild(wrap);
  }
  body.appendChild(grid);
  if (hint) {
    const hi = document.createElement("div");
    hi.className = "hint-text";
    hi.style.marginTop = "10px";
    hi.textContent = hint;
    body.appendChild(hi);
  }

  $("modal-backdrop").classList.add("open");
  $("modal-ok").onclick = async () => {
    const out = {};
    for (const f of fields) {
      if (f.type === "multi") {
        out[f.key] = [...document.querySelectorAll(`#f-${f.key} input:checked`)].map(c => c.value);
      } else if (f.type === "filters") {
        const filters = [];
        for (const row of document.querySelectorAll(`#f-${f.key} .filter-row`)) {
          const field = row.querySelector(".fr-field").value.trim();
          const op = row.querySelector(".fr-op").value;
          const raw = row.querySelector(".fr-val").value.trim();
          if (!field) continue;
          filters.push({ field, op, value: parseFilterValue(op, raw) });
        }
        out[f.key] = filters;
      } else if (f.type === "joins") {
        const joins = [];
        for (const row of document.querySelectorAll(`#f-${f.key} .join-row`)) {
          const table = row.querySelector(".jr-table").value.trim();
          if (!table) continue;
          joins.push({ table, alias: row.querySelector(".jr-alias").value.trim() || null,
                       on: row.querySelector(".jr-on").value.trim() });
        }
        out[f.key] = joins;
      } else if (f.type === "pre") {
        continue;
      } else if (f.type === "tags") {
        out[f.key] = [...document.querySelectorAll(`#f-${f.key} .chip-tag .tag-x`)].map(c => c.dataset.t);
      } else {
        const el = document.getElementById("f-" + f.key);
        let val = el.value;
        if (f.type === "number") val = val === "" ? 0 : Number(val);
        out[f.key] = val;
      }
      if (f.required && (out[f.key] === "" || out[f.key] === null || out[f.key] === undefined)) {
        $("modal-msg").textContent = `请填写「${f.label}」`;
        $("modal-msg").style.color = "var(--danger)";
        return;
      }
    }
    const btn = $("modal-ok");
    btn.disabled = true; btn.textContent = "提交中…";
    try {
      // onOk 返回 true：调用方自行接管（如修改后弹重导计划），不再自动关闭/提示
      if (await onOk(out, value) === true) return;
      closeModal();
      toast("保存成功");
    } catch (e) {
      $("modal-msg").textContent = e.message;
      $("modal-msg").style.color = "var(--danger)";
    } finally {
      btn.disabled = false; btn.textContent = "保 存";
    }
  };
  $("modal-cancel").onclick = closeModal;
  $("modal-close").onclick = closeModal;
  $("modal-backdrop").onclick = e => { if (e.target === $("modal-backdrop")) closeModal(); };
}

function parseFilterValue(op, raw) {
  const s = String(raw).trim();
  if (["IN", "NOT IN", "BETWEEN"].includes(op)) {
    return s.split(/[,，\s]+/).filter(Boolean).map(v => {
      const n = Number(v);
      return isNaN(n) ? v : n;
    });
  }
  if (s === "") return s;
  const n = Number(s);
  return isNaN(n) ? s : n;
}

function closeModal() {
  $("modal-backdrop").classList.remove("open");
  $("modal-body").innerHTML = "";
}

// ---------------------------------------------------------------- 数据加载
async function loadMeta() {
  const [overview, metrics, dims, domains, processes, models, downstreams, apps, datasets] = await Promise.all([
    api("/overview"), api("/metrics"), api("/dimensions"),
    api("/domains?page_size=100"), api("/processes"), api("/logical-models"),
    api("/downstream-models?page_size=100"),
    api("/downstream-apps?page_size=100"), api("/datasets?page_size=100"),
  ]);
  META = metrics;
  DIMS = dims;
  DOMAINS = domains.items || domains;
  PROCESSES = processes;
  LOGICAL_MODELS = models;
  DOWNSTREAMS = downstreams.items || downstreams;
  APPS = apps.items || apps;
  DATASETS = datasets.items || datasets;
  // 物理表全集（用于逻辑模型表选择）
  const set = new Set();
  PROCESSES.forEach(p => set.add(p.physical_table));
  DIMS.forEach(d => set.add(d.physical_table));
  META.atomic.forEach(a => set.add(a.table));
  LOGICAL_MODELS.forEach(m => set.add(m.physical_table));
  PHYSICAL_TABLES = [...set].sort();
  renderOverview(overview);
}

function renderOverview(o) {
  $("overview").innerHTML = [
    ["domains", "主题域"], ["processes", "业务过程"], ["atomic", "原子指标"],
    ["derived", "派生指标"], ["composite", "复合指标"], ["dimensions", "维度"],
    ["logical_models", "逻辑模型"], ["downstream_models", "下游模型"],
    ["downstream_apps", "下游应用"], ["datasets", "数据集"],
  ].map(([k, label]) => `<div class="overview-item"><b>${o[k] ?? 0}</b><span>${label}</span></div>`).join("");
}

async function refreshAll() {
  await loadMeta();
  fillAllSelects();
  switchTab(CURRENT_TAB);
}

// ---------------------------------------------------------------- 全局渲染
const TITLES = {
  query: ["统一指标查询", "指标（多选） + 统计维度 + 日期粒度 → 自动生成并执行查询，口径一致"],
  domains: ["主题域", "业务领域的高层划分，用于组织管理指标和维度"],
  processes: ["业务过程", "企业活动过程中不可拆分的事件，是指标定义的基础"],
  atomics: ["原子指标", "业务过程的度量值，由「业务过程 + 度量方式」构成，不可再拆分"],
  dims: ["维度与维度属性", "观察和分析数据的角度，属性的统一定义和管理"],
  derived: ["派生指标", "原子指标 + 修饰词（时间周期 / 统计粒度 / 筛选条件）派生为业务指标"],
  composites: ["复合指标", "基于派生指标的四则运算，如 客单价 = 支付金额 ÷ 支付笔数"],
  approvals: ["审批中心", "指标提交发布后进入审批流程：同意 → 正式生效（PUBLISHED），驳回 → 保持原状态"],
  models: ["逻辑模型", "将物理表映射为逻辑模型，屏蔽底层表结构差异（P1）"],
  downstreams: ["下游模型", "基于逻辑模型 + 指标集合生成 DWS 汇总表，支持物化落地；上游更新上线后可按时间范围重导（默认近 3 个月）"],
  reimport: ["任务重导", "选择模型/指标/维度 → 查看下游任务血缘 → 生成重导执行计划并手动执行；指标维度修改后自动提示受影响下游"],
  quality: ["质量监控", "质量规则自动/手动检查 + 健康度总览（绿/黄/红），失败自动生成站内告警"],
  ops: ["任务运维", "周期调度配置（日/间隔）+ 任务实例运行记录，物化 / 重导 / 质量检查失败可重试"],
  datasets: ["数据集", "可被下游应用调用的数据资产：物化表直读 / 指标实时计算，供报表看板消费"],
  openapi: ["开放 API", "下游应用通过 AppKey + AppSecret 认证直接查询数据集，调用可监控"],
  lineage: ["血缘追溯", "指标血缘（原子 → 派生 → 复合）+ 表血缘（物理表 → 逻辑模型 → 下游模型）"],
};

function switchTab(tab) {
  CURRENT_TAB = tab;
  closeAlertDropdown(); // 切换页签时收起通知下拉
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + tab));
  const [t, s] = TITLES[tab];
  $("page-title").textContent = t;
  $("page-subtitle").textContent = s;
  if (tab === "query") fillAllSelects();
  if (tab === "domains") renderDomains();
  else if (tab === "processes") renderProcesses();
  else if (tab === "atomics") renderAtomics();
  else if (tab === "dims") renderDims();
  else if (tab === "derived") renderDerived();
  else if (tab === "composites") renderComposites();
  else if (tab === "approvals") renderApprovals();
  else if (tab === "models") renderModels();
  else if (tab === "downstreams") renderDownstreams();
  else if (tab === "reimport") renderReimport();
  else if (tab === "quality") renderQuality();
  else if (tab === "ops") renderOps();
  else if (tab === "datasets") renderDatasets();
  else if (tab === "openapi") renderOpenapi();
  else if (tab === "lineage") renderLineage();
  refreshAlertBadge();
}

function fillAllSelects() {
  // 查询页指标多选 chips（原子 / 派生 / 复合）
  const chips = $("metric-chips");
  if (chips) {
    chips.innerHTML = ["atomic", "derived", "composite"].flatMap(t =>
      META[t].map(m =>
        `<label class="chip"><input type="checkbox" value="${esc(m.code)}">${esc(m.name)}</label>`)).join("");
    chips.querySelectorAll("input").forEach(c => c.onchange = () => c.closest(".chip").classList.toggle("active", c.checked));
    if (!chips.querySelector("input:checked")) {
      const first = chips.querySelector("input");
      if (first) { first.checked = true; first.closest(".chip").classList.add("active"); }
    }
  }

  // 维度勾选（查询页 + 新建派生，默认 dim_city）
  $("dim-chips").innerHTML = DIMS.map(d =>
    `<label class="chip${d.code === "dim_city" ? " active" : ""}"><input type="checkbox" value="${esc(d.code)}" ${d.code === "dim_city" ? "checked" : ""}>${esc(d.name)}</label>`).join("");
  $("dim-chips").querySelectorAll("input").forEach(c => c.onchange = () => c.closest(".chip").classList.toggle("active", c.checked));

  // 血缘
  const ls = $("lineage-select");
  ls.innerHTML = ["atomic", "derived", "composite"].flatMap(t => META[t]).map(m =>
    `<option value="${esc(m.code)}">${TYPE_LABEL[m.type]} · ${esc(m.name)}</option>`).join("");
}

// ---------------------------------------------------------------- 统一指标查询
async function runQuery() {
  const codes = [...$("metric-chips").querySelectorAll("input:checked")].map(c => c.value);
  if (!codes.length) { toast("请至少选择一个指标", false); return; }
  const body = {
    metric_codes: codes,
    dim_codes: [...$("dim-chips").querySelectorAll("input:checked")].map(c => c.value),
    granularity: $("granularity-select").value,
    start_date: $("start-date").value || null,
    end_date: $("end-date").value || null,
  };
  LAST_QUERY = body;
  try {
    const d = await post("/query", body);
    const s = d.summary;
    const metricChips = s.metric_names.map((n, i) =>
      `<span class="tag agg">${esc(n)}<span class="hint-text" style="margin-left:4px">${TYPE_LABEL[s.metric_types[i]]}</span></span>`).join(" ");
    const perMetric = (s.metrics || []).map(m =>
      `<div class="sum-card total"><b>${fmt(m.total)}</b><span>${esc(m.name)}合计</span></div>`).join("");
    $("summary-cards").innerHTML = `
      <div class="sum-card" style="grid-column:span 2;justify-content:center">
        <div style="display:flex;flex-wrap:wrap;gap:6px">${metricChips}</div>
        <span>粒度：${GRANULARITY_LABEL[s.granularity] || s.granularity} · 口径一致</span>
      </div>
      <div class="sum-card total"><b>${s.row_count}</b><span>分组行数</span></div>
      ${perMetric}`;
    $("result-hint").textContent = `${s.metric_names.length} 个指标 · ${d.columns.length - 1 - s.metric_names.length} 个统计维度 · ${s.row_count} 行`;
    renderTable($("result-table"), d.columns, d.rows);
    renderChart(d.columns, d.rows, s.metric_names.length);
    $("sql-preview").innerHTML = "<code>" + esc(d.sql) + "</code>";
  } catch (e) {
    $("summary-cards").innerHTML = "";
    $("result-table").innerHTML = `<tr><td class="empty">${esc(e.message)}</td></tr>`;
    $("chart").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    $("sql-preview").innerHTML = "<code>// " + esc(e.message) + "</code>";
  }
}

function renderTable(el, cols, rows) {
  // 列顺序契约：date_bucket, ...维度, ...指标
  const head = `<thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>`;
  const body = rows.map(r => `<tr>${r.map((v, i) => {
    const cls = typeof v === "number" ? "num" : "";
    return `<td class="${cls}">${esc(fmt(v))}</td>`;
  }).join("")}</tr>`).join("");
  el.innerHTML = head + `<tbody>${body || `<tr><td colspan="${Math.max(cols.length, 1)}" class="empty">无数据</td></tr>`}</tbody>`;
}

function renderChart(cols, rows, nMetrics, el) {
  el = el || $("chart");
  const nDims = cols.length - 1 - nMetrics;
  if (!rows.length) { el.innerHTML = `<p class="empty">无数据</p>`; return; }
  const data = rows.slice(0, 12);
  const metricCols = cols.slice(1 + nDims);
  const groupLabel = r => nDims > 0 ? r.slice(1, 1 + nDims).join(" / ") + " · " + r[0] : String(r[0]);
  const max = Math.max(...data.flatMap(r => metricCols.map((_, i) => r[1 + nDims + i] ?? 0)));
  const barH = 14, barGap = 3, rowGap = 12, pad = 150, legendH = nMetrics > 1 ? 26 : 0;
  const rowH = nMetrics * (barH + barGap) - barGap;
  const H = legendH + data.length * (rowH + rowGap) + 10;
  const W = 760;
  const colors = metricCols.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);
  const svg = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><title>指标可视化</title>`];
  metricCols.forEach((c, i) => {
    svg.push(`<rect x="${pad}" y="${14 + i * 18}" width="10" height="10" rx="2" fill="${colors[i]}"/>` +
      `<text x="${pad + 16}" y="${23 + i * 18}" font-size="11" fill="#64748b">${esc(c)}</text>`);
  });
  data.forEach((r, gi) => {
    const y0 = legendH + gi * (rowH + rowGap) + 5;
    const label = groupLabel(r);
    svg.push(`<text x="${pad - 8}" y="${y0 + rowH / 2}" text-anchor="end" dominant-baseline="central" font-size="12" fill="#64748b">${esc(label.length > 22 ? label.slice(0, 22) + "…" : label)}</text>`);
    metricCols.forEach((c, i) => {
      const v = r[1 + nDims + i];
      if (v === null || v === undefined) return;
      const y = y0 + i * (barH + barGap);
      const w = max ? (W - pad - 80) * (v / max) : 0;
      svg.push(`<rect x="${pad}" y="${y}" width="${Math.max(w, 2)}" height="${barH}" rx="3" fill="${colors[i]}"/>`);
      svg.push(`<text x="${pad + Math.max(w, 2) + 6}" y="${y + barH / 2}" dominant-baseline="central" font-size="11" fill="#1e293b">${esc(fmt(v))}</text>`);
    });
  });
  svg.push("</svg>");
  el.innerHTML = `<div class="chart-legend">${metricCols.map((c, i) =>
    `<span><i style="background:${colors[i]}"></i>${esc(c)}</span>`).join("")}</div>` + svg.join("");
}

function exportExcel() {
  if (!LAST_QUERY) { toast("请先执行一次查询", false); return; }
  const q = LAST_QUERY;
  const params = new URLSearchParams({ metric_codes: q.metric_codes.join(","), dim_codes: q.dim_codes.join(","), granularity: q.granularity });
  if (q.start_date) params.set("start_date", q.start_date);
  if (q.end_date) params.set("end_date", q.end_date);
  const a = document.createElement("a");
  a.href = `${API}/query/export?${params}`;
  a.download = `metric_${q.metric_codes[0]}_multi.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// 行/列 → 等宽纯文本表格（下游模型预览/物化表数据展示）
function toTextTable(cols, rows) {
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => String(fmt(r[i])).length)));
  const line = (arr, padRight) => cols.map((c, i) => {
    const s = String(arr[i] ?? "");
    return padRight ? s.padEnd(widths[i]) : s;
  }).join("  |  ");
  return [line(cols, true), ...rows.map(r => line(r, false)), `共 ${rows.length} 行`].join("\n");
}

// ---------------------------------------------------------------- 通用删除/确认
// 页面内确认弹窗（替代 window.confirm）：可自动化、不阻塞主线程；确定 true / 取消 false
function confirmModal(title, message, okText = "确 认") {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    openModal({ title, hint: message, width: 480, onOk: async () => { finish(true); return true; } });
    $("modal-ok").textContent = okText;
    $("modal-cancel").onclick = () => finish(false);
    $("modal-close").onclick = () => finish(false);
    $("modal-backdrop").onclick = e => { if (e.target === $("modal-backdrop")) finish(false); };
    document.addEventListener("keydown", e => { if (e.key === "Escape") finish(false); }, { once: true });
  });
}

async function confirmDelete(message, fn) {
  if (!(await confirmModal("确认删除", message, "删 除"))) return;
  try {
    await fn();
    toast("删除成功");
    await refreshAll();
  } catch (e) {
    toast(e.message, false);
  }
}

function listenerWrap(fn) {
  return async e => {
    e.preventDefault();
    await fn(e);
  };
}

// ---------------------------------------------------------------- 主题域
function renderDomains() {
  const kw = $("kw-domains").value.trim();
  api(`/domains?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-domains").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>描述</th><th>排序</th><th>业务过程数</th><th>维度数</th><th style="width:170px">操作</th></tr></thead>` +
      `<tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td class="hint-text">${esc(x.description)}</td>
        <td class="num">${x.sort_order}</td><td class="num">${x.process_count}</td><td class="num">${x.dimension_count}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="7" class="empty">暂无主题域</td></tr>`}</tbody>`;
  });
}

async function domainForm(id) {
  let v = { code: "", name: "", description: "", sort_order: 0 };
  if (id) v = { ...v, ...(await api(`/domains/${id}`)), id };
  openModal({
    title: id ? "编辑主题域" : "新建主题域",
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 trade / user" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 交易域" },
      { key: "description", label: "描述", type: "textarea", span: 2 },
      { key: "sort_order", label: "排序", type: "number" },
    ],
    value: v,
    onOk: async (o) => {
      if (id) await put(`/domains/${id}`, o);
      else await post("/domains", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 业务过程
function renderProcesses() {
  const kw = $("kw-processes").value.trim();
  api(`/processes${kw ? "?keyword=" + encodeURIComponent(kw) : ""}`).then(list => {
    $("tbl-processes").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>主题域</th><th>物理表</th><th>日期字段</th><th>原子指标数</th><th style="width:170px">操作</th></tr></thead>
      <tbody>${(list || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.domain_name)}</td>
        <td><span class="tag">${esc(x.physical_table)}</span></td><td><code>${esc(x.date_field)}</code></td>
        <td class="num">${x.atomic_count}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="7" class="empty">暂无业务过程</td></tr>`}</tbody>`;
  });
}

async function processForm(id) {
  let v = { code: "", name: "", domain_id: DOMAINS[0]?.id ?? "", physical_table: "", date_field: "order_date", description: "" };
  if (id) v = { ...v, ...(await api(`/processes/${id}`)), id };
  openModal({
    title: id ? "编辑业务过程" : "新建业务过程",
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 pay" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 支付" },
      { key: "domain_id", label: "主题域", type: "select", required: true, options: DOMAINS.map(d => ({ value: d.id, label: d.name })) },
      { key: "physical_table", label: "物理事实表", type: "text", required: true, placeholder: "如 dwd_pay_detail" },
      { key: "date_field", label: "时间字段", type: "text", placeholder: "如 pay_date" },
      { key: "description", label: "描述", type: "textarea", span: 2 },
    ],
    value: v,
    onOk: async (o) => {
      if (id) await put(`/processes/${id}`, o);
      else await post("/processes", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 原子指标
function tagChips(tags) {
  return (tags || []).map(t => `<span class="tag attr">${esc(t)}</span>`).join("") || '<span class="hint-text">-</span>';
}

// 批量设置实体标签（全量替换）
async function saveTags(entityType, entityId, tags) {
  await post("/entity-tags", { entity_type: entityType, entity_id: entityId, tags: tags || [] });
}

function renderAtomics() {
  const kw = $("kw-atomics").value.trim();
  api(`/atomic-metrics?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-atomics").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>业务过程</th><th>聚合方式</th><th>物理字段</th><th>单位</th><th>状态</th><th>标签</th><th style="width:300px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.process_name)}</td>
        <td><span class="tag agg">${x.agg_function}</span></td>
        <td><span class="tag">${esc(x.physical_table)}.${esc(x.physical_field)}</span></td>
        <td>${esc(x.unit)}</td>
        <td>${statusBadge(x.status)}</td>
        <td>${tagChips(x.tags)}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="status" data-id="${x.id}">${x.status === "PUBLISHED" ? "归档" : "提交发布"}</button>
          <button class="btn-ghost btn-sm" data-act="versions" data-id="${x.id}">版本</button>
          <button class="btn-ghost btn-sm" data-act="impact" data-id="${x.id}">影响</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="9" class="empty">暂无原子指标</td></tr>`}</tbody>`;
  });
}

function statusBadge(s) {
  const cls = { DRAFT: "", PUBLISHED: "pub", ARCHIVED: "arch" }[s] || "";
  return `<span class="badge status ${cls}">${STATUS_LABEL[s] || s}</span>`;
}

async function atomicForm(id) {
  let v = { code: "", name: "", process_id: PROCESSES[0]?.id ?? "", agg_function: "SUM", physical_field: "", data_type: "DECIMAL", unit: "", description: "", status: "DRAFT" };
  if (id) v = { ...v, ...(await api(`/atomic-metrics/${id}`)), id };
  openModal({
    title: id ? "编辑原子指标" : "新建原子指标",
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 pay_amount_sum" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 支付金额" },
      { key: "process_id", label: "所属业务过程", type: "select", required: true, options: PROCESSES.map(p => ({ value: p.id, label: p.name })) },
      { key: "agg_function", label: "聚合方式", type: "select", required: true, options: AGG_FUNCTIONS.map(a => ({ value: a, label: a })) },
      { key: "physical_field", label: "物理字段", type: "text", required: true, placeholder: "如 pay_amount" },
      { key: "data_type", label: "数据类型", type: "select", options: ["DECIMAL", "INT", "BIGINT", "STRING", "DATE"].map(a => ({ value: a, label: a })) },
      { key: "unit", label: "单位", type: "text", placeholder: "如 元 / 次" },
      { key: "status", label: "状态", type: "status" },
      { key: "description", label: "业务说明", type: "textarea", span: 2 },
      { key: "tags", label: "标签", type: "tags", span: 2, placeholder: "回车添加，如 核心指标" },
    ],
    value: v,
    onOk: async (o) => {
      if (id) {
        await put(`/atomic-metrics/${id}`, o);
        await saveTags("atomic_metric", id, o.tags || []);
        await refreshAll();
        // 口径已更新：存在受影响下游则自动弹出重导执行计划（返回 true 接管关闭）
        return checkImpactAfterUpdate("atomic_metric", id);
      }
      await post("/atomic-metrics", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 维度 + 属性
function renderDims() {
  const kw = $("kw-dims").value.trim();
  api(`/dimensions${kw ? "?keyword=" + encodeURIComponent(kw) : ""}`).then(list => {
    $("tbl-dims").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>主题域</th><th>物理表</th><th>关联键</th><th>属性</th><th>标签</th><th style="width:320px">操作</th></tr></thead>
      <tbody>${(list || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.domain_name)}</td>
        <td><span class="tag">${esc(x.physical_table)}</span></td>
        <td><code>${esc(x.join_field)}</code></td>
        <td>${(x.attributes || []).map(a => `<span class="tag attr" title="${esc(a.physical_field)}">${esc(a.name)}</span>`).join("") || '<span class="hint-text">-</span>'}</td>
        <td>${tagChips(x.tags)}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="attrs" data-id="${x.id}">属性</button>
          <button class="btn-ghost btn-sm" data-act="versions" data-id="${x.id}">版本</button>
          <button class="btn-ghost btn-sm" data-act="impact" data-id="${x.id}">影响</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="8" class="empty">暂无维度</td></tr>`}</tbody>`;
  });
}

async function dimForm(id) {
  let v = { code: "", name: "", domain_id: DOMAINS[0]?.id ?? "", physical_table: "", join_field: "", name_field: "", description: "" };
  if (id) v = { ...v, ...(await api(`/dimensions/${id}`)) };
  openModal({
    title: id ? "编辑维度" : "新建维度",
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 dim_city" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 城市" },
      { key: "domain_id", label: "主题域", type: "select", required: true, options: DOMAINS.map(d => ({ value: d.id, label: d.name })) },
      { key: "physical_table", label: "物理维度表", type: "text", required: true, placeholder: "如 dim_city" },
      { key: "join_field", label: "关联字段（与事实表 JOIN）", type: "text", required: true, placeholder: "如 city_id" },
      { key: "name_field", label: "展示字段（分组显示）", type: "text", required: true, placeholder: "如 city_name" },
      { key: "description", label: "描述", type: "textarea", span: 2 },
      { key: "tags", label: "标签", type: "tags", span: 2, placeholder: "回车添加，如 公共维度" },
    ],
    value: v,
    onOk: async (o) => {
      if (id) {
        await put(`/dimensions/${id}`, o);
        await saveTags("dimension", id, o.tags || []);
        await refreshAll();
        return checkImpactAfterUpdate("dimension", id);
      }
      await post("/dimensions", o);
      await refreshAll();
    },
  });
}

// 维度属性管理弹窗
async function attrManager(dimId) {
  const dim = (await api(`/dimensions/${dimId}`));
  const listRow = a => `<div class="attr-row">
      <div><b>${esc(a.name)}</b><span class="hint-text">${esc(a.code)} · ${esc(a.physical_field)} · ${esc(a.data_type)}</span></div>
      <button class="btn-ghost btn-sm danger" data-del-attr="${a.id}">删除</button></div>`;
  $("modal-title").textContent = `维度属性管理 · ${dim.name}`;
  $("modal").style.width = "560px";
  $("modal-msg").textContent = "";
  $("modal-body").innerHTML = `
    <div class="attr-list">${dim.attributes.map(listRow).join("") || '<p class="empty">暂无属性</p>'}</div>
    <div class="attr-add">
      <div class="form-grid">
        <div class="field"><label>属性编码 *</label><input id="a-code" placeholder="如 city_name"></div>
        <div class="field"><label>属性名称 *</label><input id="a-name" placeholder="如 城市名称"></div>
        <div class="field"><label>物理字段 *</label><input id="a-field" placeholder="如 city_name"></div>
        <div class="field"><label>数据类型</label><select id="a-type"><option>STRING</option><option>INT</option><option>DECIMAL</option><option>DATE</option></select></div>
      </div>
      <button class="btn-primary btn-sm" style="margin-top:12px" id="a-add">+ 添加属性</button>
      <span class="hint-text" id="a-msg"></span>
    </div>`;
  $("modal-backdrop").classList.add("open");
  $("modal-ok").style.display = "none";
  $("modal-cancel").style.display = "none";
  $("modal-close").onclick = closeModal;
  $("modal-backdrop").onclick = e => { if (e.target === $("modal-backdrop")) closeModal(); };
  $("a-add").onclick = async () => {
    const body = { code: $("a-code").value.trim(), name: $("a-name").value.trim(),
                   physical_field: $("a-field").value.trim(), data_type: $("a-type").value };
    if (!body.code || !body.name) { $("a-msg").textContent = "请填写编码和名称"; return; }
    try {
      await post(`/dimensions/${dimId}/attributes`, body);
      await attrManager(dimId);
      $("a-msg").textContent = "已添加";
    } catch (e) { $("a-msg").textContent = e.message; }
    await refreshAll();
  };
  document.querySelectorAll("[data-del-attr]").forEach(b => b.onclick = async () => {
    try {
      await del(`/dimension-attributes/${b.dataset.delAttr}`);
      await attrManager(dimId);
    } catch (e) { toast(e.message, false); }
    await refreshAll();
  });
}


// ---------------------------------------------------------------- 派生指标
function renderDerived() {
  const kw = $("kw-derived").value.trim();
  api(`/derived-metrics?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-derived").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>原子指标</th><th>时间周期</th><th>统计粒度</th><th>业务限定</th><th>状态</th><th style="width:330px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td>
        <td><span class="tag agg">${esc(x.atomic_code)}</span></td>
        <td>${PERIOD_LABEL[x.time_period] || x.time_period}</td>
        <td>${(x.dim_codes || []).map(c => `<code>${esc(c)}</code>`).join(" ") || '<span class="hint-text">-</span>'}</td>
        <td>${(x.filters || []).map(f => `<code class="flt">${esc(f.field)} ${esc(f.op)} ${esc(Array.isArray(f.value) ? f.value.join(",") : f.value)}</code>`).join(" ") || '<span class="hint-text">无</span>'}</td>
        <td>${statusBadge(x.status)}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="sql" data-id="${x.id}">SQL</button>
          <button class="btn-ghost btn-sm" data-act="versions" data-id="${x.id}">版本</button>
          <button class="btn-ghost btn-sm" data-act="impact" data-id="${x.id}">影响</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="8" class="empty">暂无派生指标</td></tr>`}</tbody>`;
  });
}

async function derivedForm(id) {
  let v = { code: "", name: "", atomic_code: META.atomic[0]?.code ?? "", time_period: "7d",
            dim_codes: ["dim_city"], filters: [], description: "", status: "PUBLISHED" };
  if (id) {
    const d = await api(`/derived-metrics/${id}`);
    v = { ...v, code: d.code, name: d.name, atomic_code: d.atomic.code, time_period: d.time_period,
          dim_codes: (d.dims || []).map(x => x.code), filters: d.filters, description: d.description, status: d.status };
  }
  openModal({
    title: id ? "编辑派生指标" : "新建派生指标（派生规则引擎）",
    width: 720,
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 pay_amount_30d_cat" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 最近30天各类目支付金额" },
      { key: "atomic_code", label: "原子指标（度量）", type: "select", required: true, options: META.atomic.map(a => ({ value: a.code, label: `${a.name}（${a.agg}(${a.field})）` })) },
      { key: "time_period", label: "时间周期（修饰词 ①）", type: "select", required: true, options: Object.entries(PERIOD_LABEL).map(([k, l]) => ({ value: k, label: l })) },
      { key: "dim_codes", label: "统计粒度（修饰词 ②）", type: "multi", options: DIMS.map(d => ({ value: d.code, label: d.name })) },
      { key: "filters", label: "业务限定（修饰词 ③）", type: "filters", span: 2, hint: "运算符支持 = != > >= < <= IN NOT IN BETWEEN LIKE" },
      { key: "status", label: "状态", type: "status" },
      { key: "description", label: "业务说明", type: "textarea", span: 2 },
      { key: "tags", label: "标签", type: "tags", span: 2, placeholder: "回车添加，如 核心指标" },
    ],
    value: v,
    onOk: async (o) => {
      if (id) {
        await put(`/derived-metrics/${id}`, o);
        await saveTags("derived_metric", id, o.tags || []);
        await refreshAll();
        return checkImpactAfterUpdate("derived_metric", id);
      }
      await post("/derived-metrics", o);
      await refreshAll();
    },
  });
}

// SQL 预览弹窗
function sqlPreviewModal(title, sql, params) {
  openModal({
    title, width: 860,
    fields: [{ key: "_sql", label: "动态生成 SQL（元数据 → 语句）", type: "pre", span: 2 }],
    value: { _sql: sql },
    onOk: async () => {},
  });
  $("modal-ok").style.display = "none";
  $("modal-cancel").textContent = "关 闭";
  $("modal-cancel").onclick = closeModal;
  if (params) {
    const p = document.createElement("div");
    p.className = "hint-text form-pre";
    p.style.marginTop = "10px";
    p.textContent = "绑定参数: " + JSON.stringify(params);
    $("modal-body").appendChild(p);
  }
}

// ---------------------------------------------------------------- 复合指标
function renderComposites() {
  const kw = $("kw-composites").value.trim();
  api(`/composite-metrics?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-composites").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>计算表达式</th><th>引用指标</th><th>单位</th><th style="width:300px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td>
        <td><code class="flt">${esc(x.expression)}</code></td>
        <td>${(x.ref_codes || []).map(c => `<span class="tag agg">${esc(c)}</span>`).join(" ")}</td>
        <td>${esc(x.unit)}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="sql" data-id="${x.id}">SQL</button>
          <button class="btn-ghost btn-sm" data-act="versions" data-id="${x.id}">版本</button>
          <button class="btn-ghost btn-sm" data-act="impact" data-id="${x.id}">影响</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="6" class="empty">暂无复合指标</td></tr>`}</tbody>`;
  });
}

async function compositeForm(id) {
  let v = { code: "", name: "", expression: "", ref_codes: [], unit: "", description: "", status: "PUBLISHED" };
  if (id) v = { ...v, ...(await api(`/composite-metrics/${id}`)) };
  openModal({
    title: id ? "编辑复合指标" : "新建复合指标",
    width: 720,
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 avg_order_value" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 客单价" },
      { key: "ref_codes", label: "引用的派生指标", type: "multi", span: 2, options: META.derived.map(d => ({ value: d.code, label: `${d.name}（${d.code}）` })) },
      { key: "expression", label: "计算表达式", type: "textarea", span: 2, required: true, placeholder: "如 pay_amount_7d_city / pay_count_7d_city", hint: "用派生指标编码参与四则运算，如 pay_amount_7d_city / pay_count_7d_city" },
      { key: "unit", label: "单位", type: "text" },
      { key: "status", label: "状态", type: "status" },
      { key: "description", label: "业务说明", type: "textarea", span: 2 },
      { key: "tags", label: "标签", type: "tags", span: 2, placeholder: "回车添加，如 核心指标" },
    ],
    value: v,
    onOk: async (o) => {
      const refs = o.ref_codes || [];
      if (!refs.length) throw new Error("请至少选择一个引用的派生指标");
      for (const r of refs) {
        if (!o.expression.includes(r)) { throw new Error(`表达式未引用所选指标 ${r}`); }
      }
      if (id) {
        await put(`/composite-metrics/${id}`, o);
        await saveTags("composite_metric", id, o.tags || []);
      }
      else await post("/composite-metrics", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 逻辑模型
function renderModels() {
  api("/logical-models").then(list => {
    $("tbl-models").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>主题域</th><th>物理表</th><th>JOIN 类型</th><th>JOIN 表数</th><th style="width:300px">操作</th></tr></thead>
      <tbody>${(list || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.domain_name)}</td>
        <td><span class="tag">${esc(x.physical_table)}</span></td>
        <td>${x.join_type === "JOIN" ? `<span class="badge status pub">JOIN</span>` : `<span class="badge soft">SINGLE</span>`}</td>
        <td class="num">${(x.join_config || []).length}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="sql" data-id="${x.id}">SQL</button>
          <button class="btn-ghost btn-sm" data-act="versions" data-id="${x.id}">版本</button>
          <button class="btn-ghost btn-sm" data-act="impact" data-id="${x.id}">影响</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="7" class="empty">暂无逻辑模型</td></tr>`}</tbody>`;
  });
}

async function modelForm(id) {
  let v = { code: "", name: "", domain_id: DOMAINS[0]?.id ?? "", physical_table: PHYSICAL_TABLES[0] || "", join_type: "SINGLE", join_config: [], description: "" };
  if (id) v = { ...v, ...(await api(`/logical-models/${id}`)) };
  openModal({
    title: id ? "编辑逻辑模型" : "新建逻辑模型（P1）",
    width: 760,
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 trade_wide" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 交易宽表" },
      { key: "domain_id", label: "主题域", type: "select", required: true, options: DOMAINS.map(d => ({ value: d.id, label: d.name })) },
      { key: "physical_table", label: "主表（物理表）", type: "text", required: true, placeholder: "如 dwd_order_detail" },
      { key: "join_type", label: "JOIN 类型", type: "select", required: true, options: JOIN_TYPES.map(j => ({ value: j, label: j === "SINGLE" ? "SINGLE（单表）" : "JOIN（多表关联）" })) },
      { key: "join_config", label: "JOIN 配置（关联表与条件）", type: "joins", span: 2, hint: "ON 条件示例: t.city_id = d0.city_id" },
      { key: "description", label: "描述", type: "textarea", span: 2 },
      { key: "tags", label: "标签", type: "tags", span: 2, placeholder: "回车添加，如 核心模型" },
    ],
    value: v,
    onOk: async (o) => {
      if (o.join_type === "SINGLE") o.join_config = [];
      if (id) {
        await put(`/logical-models/${id}`, o);
        await saveTags("logical_model", id, o.tags || []);
        await refreshAll();
        return checkImpactAfterUpdate("logical_model", id);
      }
      await post("/logical-models", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 下游模型
function renderDownstreams() {
  const kw = $("kw-downstreams").value.trim();
  api(`/downstream-models?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-downstreams").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>来源逻辑模型</th><th>粒度</th><th>汇总指标（维度）</th><th>物化状态</th><th>物化表 / 行数</th><th style="width:400px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td>
        <td>${esc(x.name)}</td>
        <td>${esc(x.source_model_name)}</td>
        <td>${GRANULARITY_LABEL[x.granularity] || x.granularity}</td>
        <td>${(x.metrics || []).map(mc =>
          `<span class="tag agg" title="维度: ${esc((mc.dim_codes || []).join(", "))}">${esc(mc.metric_code)}</span>`).join(" ") || '<span class="hint-text">-</span>'}</td>
        <td>${x.materialized ? `<span class="badge status pub">已物化</span>` : `<span class="badge status">未物化</span>`}</td>
        <td>${x.materialized ? `<code>${esc(x.physical_table)}</code> <span class="hint-text">${x.row_count} 行</span>` : '<span class="hint-text">-</span>'}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="mat" data-id="${x.id}">${x.materialized ? "重新物化" : "物化"}</button>
          <button class="btn-ghost btn-sm" data-act="reimport" data-id="${x.id}" title="上游逻辑模型/指标更新上线后，按时间范围重导数据（默认近 3 个月）">重导</button>
          <button class="btn-ghost btn-sm" data-act="preview" data-id="${x.id}">预览</button>
          <button class="btn-ghost btn-sm" data-act="data" data-id="${x.id}">数据</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="8" class="empty">暂无下游模型</td></tr>`}</tbody>`;
  });
}

async function downstreamForm(id) {
  let v = { code: "", name: "", source_model_id: LOGICAL_MODELS[0]?.id ?? "",
            metric_codes: [], dim_codes: ["dim_city"], granularity: "day", description: "" };
  if (id) {
    const d = await api(`/downstream-models/${id}`);
    v = { code: d.code, name: d.name, source_model_id: d.source_model_id,
          metric_codes: (d.metrics || []).map(m => m.metric_code),
          dim_codes: [...new Set((d.metrics || []).flatMap(m => m.dim_codes || []))],
          granularity: d.granularity, description: d.description };
  }
  const allMetrics = ["atomic", "derived"].flatMap(t => META[t]);
  openModal({
    title: id ? "编辑下游模型" : "新建下游模型（DWS 指标汇总表）",
    width: 680,
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 city_order_daily" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 城市订单日汇总" },
      { key: "source_model_id", label: "来源逻辑模型", type: "select", required: true, options: LOGICAL_MODELS.map(m => ({ value: m.id, label: m.name })) },
      { key: "metric_codes", label: "汇总指标", type: "multi", span: 2, options: allMetrics.map(m => ({ value: m.code, label: `${m.name}（${m.code}）` })),
        hint: "原子 / 派生指标；复合指标需先展开为派生指标" },
      { key: "dim_codes", label: "公共维度（多指标对齐）", type: "multi", span: 2, options: DIMS.map(d => ({ value: d.code, label: d.name })) },
      { key: "granularity", label: "日期粒度", type: "select", options: Object.entries(GRANULARITY_LABEL).map(([k, l]) => ({ value: k, label: l })) },
      { key: "description", label: "描述", type: "textarea", span: 2 },
    ],
    value: v,
    onOk: async (o) => {
      const metrics = (o.metric_codes || []).map(c => ({ metric_code: c, dim_codes: o.dim_codes || [] }));
      if (!metrics.length) throw new Error("请至少选择一个汇总指标");
      const body = { code: o.code, name: o.name, source_model_id: Number(o.source_model_id),
                     metrics, granularity: o.granularity, description: o.description };
      if (id) await put(`/downstream-models/${id}`, body);
      else await post("/downstream-models", body);
      await refreshAll();
    },
  });
}

// 下游模型操作：物化 / 重导 / 预览 / 物化表数据
async function downstreamOp(btn) {
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === "mat") {
      const d = await post(`/downstream-models/${id}/materialize`);
      toast(`物化成功：${d.physical_table}（${d.row_count} 行）`);
      await refreshAll();
    } else if (btn.dataset.act === "reimport") {
      const info = await api(`/downstream-models/${id}`);
      if (!info.materialized) { toast("尚未物化，请先执行物化", false); return; }
      reimportModal(info);
    } else if (btn.dataset.act === "preview") {
      const d = await post(`/downstream-models/${id}/preview`);
      const info = await api(`/downstream-models/${id}`);
      sqlPreviewModal(`下游模型预览（前 100 行，不落地） · ${info.code}`, toTextTable(d.columns, d.rows));
    } else if (btn.dataset.act === "data") {
      const info = await api(`/downstream-models/${id}`);
      if (!info.materialized) { toast("尚未物化，请先执行物化", false); return; }
      const d = await api(`/downstream-models/${id}/data?page=1&page_size=100`);
      sqlPreviewModal(`物化表 ${info.physical_table} 数据（共 ${d.total} 行，前 100 行）`, toTextTable(d.columns, d.rows));
    }
  } catch (e) {
    toast(e.message, false);
  }
}

const _pad2 = n => String(n).padStart(2, "0");
const _isoDate = d => `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;

// 重导默认起点：3 个月前的当月 1 日（近 3 个月）
function reimportDefaultStart() {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  d.setDate(1);
  return _isoDate(d);
}

// 重导弹窗：选择时间范围（默认近 3 个月），区间内删除并按最新上游定义重算写入
function reimportModal(info) {
  const today = _isoDate(new Date());
  openModal({
    title: `重导数据 · ${info.code}（${info.physical_table}）`,
    width: 520,
    fields: [
      { key: "start_date", label: "开始日期", type: "date", required: true },
      { key: "end_date", label: "结束日期", type: "date", required: true },
    ],
    value: { start_date: reimportDefaultStart(), end_date: today },
    hint: "上游逻辑模型指标/维度更新上线后，重导该时间范围数据（删除区间内旧行并按最新定义重新计算写入）；默认近 3 个月",
    onOk: async (o) => {
      if (o.start_date > o.end_date) throw new Error("开始日期不能晚于结束日期");
      const d = await post(`/downstream-models/${info.id}/reimport?start_date=${o.start_date}&end_date=${o.end_date}`);
      toast(`重导完成：删除 ${d.deleted} 行，重算写入 ${d.inserted} 行（共 ${d.total_rows} 行）`);
      await refreshAll();
      renderReimportHistory();
    },
  });
}

// ---------------------------------------------------------------- 任务重导
// 选择模型/字段 → 下游任务血缘 → 生成重导执行计划 → 手动确认执行；
// 指标/维度修改保存后也会自动弹出受影响下游的执行计划
const REIMPORT_TYPE_LABEL = { atomic_metric: "原子指标", derived_metric: "派生指标", dimension: "维度", logical_model: "逻辑模型" };
let REIMPORT_IMPACT = null;   // 最近一次 impact 结果（血缘图 + 计划表）
let REIMPORT_PLAN = null;     // 最近一次 plan 预估（按下游 id 索引）

function renderReimport() {
  if (!$("reimport-start").value) $("reimport-start").value = reimportDefaultStart();
  if (!$("reimport-end").value) $("reimport-end").value = _isoDate(new Date());
  fillReimportObjects($("reimport-type").value, true);
  renderReimportHistory();
}

// 重导历史记录：单模型重导 / 计划重导均写 TaskInstance(task_type=reimport)，此处按时间倒序展示
function renderReimportHistory() {
  api("/task-instances?task_type=reimport&page=1&page_size=50").then(d => {
    $("tbl-reimport-history").innerHTML = `<thead><tr>
        <th style="width:56px">ID</th><th>对象</th><th>触发</th><th>状态</th>
        <th>开始</th><th>结束</th><th>数据范围</th><th>删除</th><th>插入</th>
        <th style="width:110px">操作</th></tr></thead><tbody>${
      (d.items || []).map(i => {
        const det = i.detail || {};
        const range = det.start_date && det.end_date ? `${det.start_date.slice(0, 10)} ~ ${det.end_date.slice(0, 10)}` : "-";
        return `<tr>
          <td class="num">${i.id}</td>
          <td><code>${esc(i.entity_code || "-")}</code></td>
          <td>${TRIGGER_LABEL[i.trigger] || i.trigger}</td>
          <td>${taskStatusBadge(i.status)}</td>
          <td class="hint-text">${esc(i.started_at || "-")}</td>
          <td class="hint-text">${esc(i.finished_at || "-")}</td>
          <td class="hint-text">${esc(range)}</td>
          <td class="num">${det.deleted == null ? '<span class="hint-text">-</span>' : fmt(det.deleted)}</td>
          <td class="num">${det.inserted == null ? '<span class="hint-text">-</span>' : fmt(det.inserted)}</td>
          <td>
            <button class="btn-ghost btn-sm" data-act="detail" data-id="${i.id}">详情</button>
            ${i.status === "FAILED" ? `<button class="btn-ghost btn-sm" data-act="retry" data-id="${i.id}">重试</button>` : ""}
          </td></tr>`;
      }).join("") || `<tr><td colspan="10" class="empty">暂无重导历史（执行单模型重导或计划重导后自动记录）</td></tr>`}</tbody>`;
    $("tbl-reimport-history").querySelectorAll("[data-act='detail']").forEach(b => b.onclick = () => taskInstanceDetail(Number(b.dataset.id)).catch(e => toast(e.message, false)));
    $("tbl-reimport-history").querySelectorAll("[data-act='retry']").forEach(b => b.onclick = () => retryTask(Number(b.dataset.id)));
  });
}

function fillReimportObjects(type, keepSelection) {
  const prev = $("reimport-object").value;
  let list = [];
  if (type === "atomic_metric") list = META.atomic.map(m => ({ value: m.id, label: `${m.name}（${m.code}）` }));
  else if (type === "derived_metric") list = META.derived.map(m => ({ value: m.id, label: `${m.name}（${m.code}）` }));
  else if (type === "dimension") list = DIMS.map(d => ({ value: d.id, label: `${d.name}（${d.code}）` }));
  else list = LOGICAL_MODELS.map(m => ({ value: m.id, label: `${m.name}（${m.code}）` }));
  $("reimport-object").innerHTML = list.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join("")
    || '<option value="">暂无可选对象</option>';
  if (keepSelection && [...$("reimport-object").options].some(o => o.value === prev)) {
    $("reimport-object").value = prev;
  }
  loadReimportImpact();
}

// 反查受影响下游模型 → 渲染血缘图 + 计划表
async function loadReimportImpact() {
  const type = $("reimport-type").value, oid = $("reimport-object").value;
  const el = $("reimport-graph");
  if (!oid) { el.innerHTML = '<p class="empty">请选择对象</p>'; $("tbl-reimport-plan").innerHTML = ""; return; }
  try {
    const d = await api(`/reimport/impact?object_type=${type}&object_id=${oid}`);
    REIMPORT_IMPACT = d; REIMPORT_PLAN = null;
    $("reimport-impact-hint").textContent =
      `对象：${REIMPORT_TYPE_LABEL[d.object.type]} ${d.object.name}（${d.object.code}）→ 受影响下游模型 ${d.downstreams.length} 个`;
    if (!d.downstreams.length) {
      el.innerHTML = '<p class="empty">该对象暂无下游模型引用</p>';
      $("tbl-reimport-plan").innerHTML = '<tr><td class="empty">暂无受影响下游模型</td></tr>';
      return;
    }
    // 血缘图：chain 结构 = 对象 →(派生中介)→ 逻辑模型 → 下游模型
    const LEVEL = { atomic_metric: 0, dimension: 0, derived_metric: 1, logical_model: 2, downstream: 3 };
    const STYLE = {
      atomic_metric: ["#eff6ff", "#2563eb", "原子指标"],
      derived_metric: ["#ecfdf5", "#059669", "派生指标"],
      dimension: ["#faf5ff", "#7c3aed", "维度"],
      logical_model: ["#eef2ff", "#6366f1", "逻辑模型"],
      downstream: ["#fff1f5", "#db2777", "下游模型"],
    };
    const nodes = new Map(), edges = [];
    d.downstreams.forEach(ds => (ds.chain || []).forEach((n, i) => {
      const id = n.type + ":" + n.code;
      if (!nodes.has(id)) nodes.set(id, { id, type: n.type, label: n.name, code: n.code });
      if (i > 0) edges.push({ from: (ds.chain[i - 1].type) + ":" + ds.chain[i - 1].code, to: id });
    }));
    renderGraph(el, { nodes: [...nodes.values()], edges }, LEVEL, STYLE);
    renderReimportPlanTable(d.downstreams, null);
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function renderReimportPlanTable(downstreams, planItems) {
  const byId = planItems ? Object.fromEntries(planItems.map(x => [x.id, x])) : {};
  $("tbl-reimport-plan").innerHTML = `<thead><tr>
      <th style="width:36px"></th><th>编码</th><th>名称</th><th>来源逻辑模型</th><th>粒度</th>
      <th>物化状态</th><th>物化表 / 行数</th><th>预估删除行数</th></tr></thead><tbody>` +
    downstreams.map(x => `<tr>
      <td><input type="checkbox" class="ri-check" data-id="${x.id}" ${x.materialized ? "checked" : ""}></td>
      <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.source_model_code || "-")}</td>
      <td>${GRANULARITY_LABEL[x.granularity] || x.granularity}</td>
      <td>${x.materialized ? '<span class="badge status pub">已物化</span>' : '<span class="badge status">未物化</span>'}</td>
      <td>${x.materialized ? `<code>${esc(x.physical_table)}</code> <span class="hint-text">${fmt(x.row_count)} 行</span>` : '<span class="hint-text">-</span>'}</td>
      <td class="ri-est" data-id="${x.id}">${byId[x.id] ? (byId[x.id].estimated_deleted == null ? '<span class="hint-text">未物化</span>' : fmt(byId[x.id].estimated_deleted) + " 行") : '<span class="hint-text">待生成</span>'}</td>
    </tr>`).join("") +
    `</tbody>`;
}

// 生成执行计划：按当前对象 + 时间范围 + 勾选模型预估删除行数
async function genReimportPlan() {
  const oid = $("reimport-object").value;
  if (!oid) { toast("请先选择对象", false); return; }
  const ids = [...document.querySelectorAll(".ri-check:checked")].map(c => Number(c.dataset.id));
  if (!ids.length) { toast("请至少勾选一个下游模型", false); return; }
  try {
    const d = await post("/reimport/plan", {
      object_type: $("reimport-type").value, object_id: Number(oid),
      start_date: $("reimport-start").value || null,
      end_date: $("reimport-end").value || null,
      downstream_ids: ids,
    });
    REIMPORT_PLAN = d;
    renderReimportPlanTable(REIMPORT_IMPACT.downstreams, d.items);
    toast(`执行计划已生成：${d.items.length} 个模型，区间 ${d.start_date} ~ ${d.end_date}`);
  } catch (e) { toast(e.message, false); }
}

// 执行选中重导（手动确认）
async function execReimportPlan() {
  const oid = $("reimport-object").value;
  if (!oid) { toast("请先选择对象", false); return; }
  const ids = [...document.querySelectorAll(".ri-check:checked")].map(c => Number(c.dataset.id));
  if (!ids.length) { toast("请至少勾选一个下游模型", false); return; }
  const s = $("reimport-start").value, e = $("reimport-end").value;
  const range = s && e ? `（${s} ~ ${e}）` : "（默认近 3 个月）";
  if (!(await confirmModal("确认执行重导",
      `确认重导 ${ids.length} 个下游模型 ${range}？未物化模型将被跳过`))) return;
  try {
    const d = await post("/reimport/plan/execute", {
      downstream_ids: ids, start_date: s || null, end_date: e || null });
    const st = { ok: 0, skipped: 0, error: 0 };
    (d.results || []).forEach(r => { st[r.status] = (st[r.status] || 0) + 1; });
    const errMsgs = (d.results || []).filter(r => r.status === "error")
      .map(r => `${r.code}: ${r.message}`).join("；");
    toast(`重导完成：成功 ${st.ok} 个，跳过 ${st.skipped} 个${st.error ? `，失败 ${st.error} 个（${errMsgs}）` : ""}`, st.error === 0);
    await refreshAll();
    renderReimportHistory();
  } catch (e) { toast(e.message, false); }
}

// 重导执行计划确认弹窗：受影响下游列表（勾选）+ 时间范围，确认后执行；
// 供「指标/维度修改后自动弹出」与页内按钮共用；返回 true 表示已接管弹窗关闭
function reimportPlanModal(object, downstreams) {
  closeModal();
  openModal({
    title: `重导执行计划 · ${object.name}（${object.code}）`,
    width: 660,
    fields: [
      { key: "downstream_ids", label: `受影响下游模型（${downstreams.length} 个）`, type: "multi", span: 2,
        options: downstreams.map(x => ({
          value: x.id,
          label: `${x.code} · ${x.name}${x.materialized ? `（已物化 ${x.row_count ?? 0} 行）` : "（未物化，执行时将跳过）"}`,
        })) },
      { key: "start_date", label: "开始日期", type: "date", required: true },
      { key: "end_date", label: "结束日期", type: "date", required: true },
    ],
    value: {
      downstream_ids: downstreams.filter(x => x.materialized).map(x => x.id),
      start_date: reimportDefaultStart(), end_date: _isoDate(new Date()),
    },
    hint: "该对象口径已更新，建议尽快重导受影响的下游物化表（删除区间内旧行并按最新定义重算）；默认近 3 个月",
    onOk: async (o) => {
      if (o.start_date > o.end_date) throw new Error("开始日期不能晚于结束日期");
      if (!o.downstream_ids.length) throw new Error("请至少勾选一个下游模型");
      const d = await post("/reimport/plan/execute", {
        downstream_ids: o.downstream_ids,
        start_date: o.start_date, end_date: o.end_date });
      const st = { ok: 0, skipped: 0, error: 0 };
      (d.results || []).forEach(r => { st[r.status] = (st[r.status] || 0) + 1; });
      const errMsgs = (d.results || []).filter(r => r.status === "error")
        .map(r => `${r.code}: ${r.message}`).join("；");
      toast(`重导完成：成功 ${st.ok} 个，跳过 ${st.skipped} 个${st.error ? `，失败 ${st.error} 个（${errMsgs}）` : ""}`, st.error === 0);
      closeModal();
      await refreshAll();
      renderReimportHistory();
      return true;   // 已自行关闭并提示，跳过 openModal 默认行为
    },
  });
  return true;
}

// 指标/维度修改保存后：反查受影响下游，有则弹执行计划确认框（新建无下游引用，不查）；
// 返回 true 表示已接管 modal 关闭（弹窗已由 reimportPlanModal 打开）
async function checkImpactAfterUpdate(type, id) {
  try {
    const d = await api(`/reimport/impact?object_type=${type}&object_id=${id}`);
    if (d.downstreams.length) return reimportPlanModal(d.object, d.downstreams);
  } catch { /* 影响分析失败不阻断保存流程 */ }
}

// ================================================================
// 治理与生命周期：版本历史 / 回滚 / 变更影响评估 / 审批发布
// ================================================================

// 版本历史弹窗：列表 + 查看快照 + 回滚
async function versionsModal(entityType, entityId) {
  const d = await api(`/metric-versions?entity_type=${entityType}&entity_id=${entityId}&page=1&page_size=50`);
  openModal({ title: "版本历史（变更前快照，最新在前）", width: 760, fields: [], onOk: async () => {} });
  $("modal-ok").style.display = "none";
  $("modal-cancel").textContent = "关 闭";
  const listHtml = () => (d.items || []).map(v => `<tr>
    <td><span class="badge status pub">${esc(v.version_no)}</span></td>
    <td>${VERSION_CHANGE_LABEL[v.change_type] || v.change_type}</td>
    <td class="hint-text">${esc(v.change_note || "-")}</td>
    <td class="hint-text">${esc(v.created_at)}</td>
    <td>
      <button class="btn-ghost btn-sm" data-v-snap="${v.id}">快照</button>
      <button class="btn-ghost btn-sm danger" data-v-rollback="${v.id}">回滚</button>
    </td></tr>`).join("");
  const renderList = () => {
    $("modal-title").textContent = "版本历史（变更前快照，最新在前）";
    $("modal-body").innerHTML = `<div class="hint-text" style="margin-bottom:10px">每次编辑 / 状态变更 / 审批发布前自动存档；回滚将把该版本快照写回实体并生成 rollback 版本记录</div>
      <div class="table-wrap"><table><thead><tr><th>版本</th><th>类型</th><th>说明</th><th>时间</th><th style="width:130px">操作</th></tr></thead>
      <tbody>${listHtml() || '<tr><td colspan="5" class="empty">暂无版本记录（编辑 / 审批等变更会自动存档）</td></tr>'}</tbody></table></div>`;
    $("modal-body").querySelectorAll("[data-v-snap]").forEach(b => b.onclick = () => {
      const ver = (d.items || []).find(v => v.id === Number(b.dataset.vSnap));
      if (!ver) return;
      $("modal-title").textContent = `版本快照 · ${ver.version_no}`;
      $("modal-body").innerHTML = `<div class="form-grid">
        <div class="field"><label>版本信息</label><pre class="form-pre">版本 ${esc(ver.version_no)} · ${VERSION_CHANGE_LABEL[ver.change_type] || ver.change_type} · ${esc(ver.created_at)}
${esc(ver.change_note || "无说明")}</pre></div>
        <div class="field"><label>快照内容（JSON）</label><pre class="form-pre" style="max-height:380px;overflow:auto">${esc(JSON.stringify(ver.snapshot, null, 2))}</pre></div>
      </div>
      <div style="margin-top:14px"><button class="btn-ghost btn-sm" id="v-back">← 返回版本列表</button></div>`;
      $("v-back").onclick = renderList;
    });
    $("modal-body").querySelectorAll("[data-v-rollback]").forEach(b => b.onclick = async () => {
      const ver = (d.items || []).find(v => v.id === Number(b.dataset.vRollback));
      if (!ver) return;
      if (!(await confirmModal("版本回滚",
          `回滚到 ${ver.version_no}（${ver.created_at}）？实体将恢复为该版本快照`, "回 滚"))) return;
      try {
        await post(`/metric-versions/${ver.id}/rollback`);
        toast("回滚成功");
        closeModal();
        await refreshAll();
      } catch (e) { toast(e.message, false); }
    });
  };
  renderList();
  $("modal-backdrop").classList.add("open");
}

// 变更影响评估弹窗：统计 + 血缘链 + 派生/复合/数据集清单
async function impactModal(objectType, objectId) {
  const r = await api(`/impact-report?object_type=${objectType}&object_id=${objectId}`);
  const s = r.summary || {};
  const cards = [
    { n: s.downstream_models ?? 0, t: "受影响下游模型" },
    { n: s.derived_metrics ?? 0, t: "派生指标" },
    { n: s.composite_metrics ?? 0, t: "复合指标" },
    { n: s.datasets ?? 0, t: "数据集" },
    { n: s.granted_apps ?? 0, t: "授权应用" },
  ];
  // 血缘链图：对象 →(派生中介)→ 逻辑模型 → 下游模型（chain[0] 即对象自身）
  const graph = { nodes: [], edges: [] };
  const seen = new Set();
  const addNode = (id, label, code, type) => {
    if (seen.has(id)) return;
    seen.add(id);
    graph.nodes.push({ id, label, code, type });
  };
  addNode("obj", r.object.name, r.object.code, objectType);
  (r.downstreams || []).forEach(dm => {
    const chain = dm.chain || [];
    let prev = "obj";
    chain.forEach((c, i) => {
      if (i === 0) return;
      const nid = `${c.type}:${c.code}`;
      addNode(nid, c.name || c.code, c.code, c.type);
      graph.edges.push({ from: prev, to: nid });
      prev = nid;
    });
  });
  const LEVEL = { atomic_metric: 0, dimension: 0, derived_metric: 1, logical_model: 2, downstream: 3 };
  const STYLE = {
    atomic_metric: ["#e6f4ff", "#1677ff", "原子指标"],
    dimension: ["#f9f0ff", "#722ed1", "维度"],
    derived_metric: ["#fff7e6", "#d46b08", "派生指标"],
    composite_metric: ["#f6ffed", "#389e0d", "复合指标"],
    logical_model: ["#f0f5ff", "#2f54eb", "逻辑模型"],
    downstream: ["#e6fffb", "#08979c", "下游模型"],
  };
  const dsRows = (r.downstreams || []).map(dm => `<tr>
    <td><code>${esc(dm.code)}</code></td><td>${esc(dm.name)}</td>
    <td>${dm.materialized ? `<span class="badge status pub">已物化</span>` : `<span class="badge soft">未物化</span>`}</td>
    <td><code>${esc(dm.physical_table || "-")}</code></td>
    <td class="num">${fmt(dm.row_count)}</td></tr>`).join("");
  const derivedChips = (r.derived || []).map(x => `<span class="tag agg">${esc(x.code)}</span>`).join(" ") || '<span class="hint-text">无</span>';
  const compositeChips = (r.composite || []).map(x => `<span class="tag">${esc(x.code)}</span>`).join(" ") || '<span class="hint-text">无</span>';
  const dsListRows = (r.datasets || []).map(ds => `<tr>
    <td><code>${esc(ds.code)}</code></td><td>${esc(ds.name)}</td>
    <td>${ds.source_type === "downstream_model" ? "物化表" : "指标实时查询"}</td>
    <td>${(ds.granted_apps || []).map(a => `<span class="tag">${esc(a.name)}</span>`).join(" ") || '<span class="hint-text">未授权</span>'}</td></tr>`).join("");
  openModal({ title: `变更影响评估 · ${r.object.name}（${r.object.code}）`, width: 860, fields: [], onOk: async () => {} });
  $("modal-ok").style.display = "none";
  $("modal-cancel").textContent = "关 闭";
  $("modal-body").innerHTML = `
    <div class="summary" style="grid-template-columns:repeat(5,1fr);margin-bottom:14px">
      ${cards.map(c => `<div class="sum-card total" style="padding:10px 14px"><b>${c.n}</b><span>${c.t}</span></div>`).join("")}
    </div>
    <div class="field"><label>影响血缘链（对象 → 逻辑模型 → 下游模型）</label>
      <div class="lineage-wrap" style="min-height:220px;margin:6px 0 16px"><div class="lineage-graph" id="impact-graph"></div></div>
    </div>
    <div class="field"><label>受影响下游模型（${(r.downstreams || []).length}）</label>
      <div class="table-wrap"><table><thead><tr><th>编码</th><th>名称</th><th>物化</th><th>物化表</th><th>行数</th></tr></thead>
      <tbody>${dsRows || '<tr><td colspan="5" class="empty">无</td></tr>'}</tbody></table></div>
    </div>
    <div class="form-grid" style="margin-top:14px">
      <div class="field"><label>引用此对象的派生指标（${(r.derived || []).length}）</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${derivedChips}</div></div>
      <div class="field"><label>引用派生指标的复合指标（${(r.composite || []).length}）</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${compositeChips}</div></div>
    </div>
    <div class="field" style="margin-top:14px"><label>关联数据集与授权应用</label>
      <div class="table-wrap"><table><thead><tr><th>编码</th><th>名称</th><th>数据源</th><th>授权应用</th></tr></thead>
      <tbody>${dsListRows || '<tr><td colspan="4" class="empty">无</td></tr>'}</tbody></table></div>
    </div>`;
  if (graph.nodes.length > 1) renderGraph($("impact-graph"), graph, LEVEL, STYLE);
  else $("impact-graph").innerHTML = '<span class="hint-text">暂无下游血缘（该对象未被任何下游模型引用）</span>';
  $("modal-backdrop").classList.add("open");
}

// 提交发布审批（入口仅原子指标行按钮；通过后置 PUBLISHED）
function submitApproval(entityType, entityId, entityName) {
  openModal({
    title: `提交发布审批 · ${entityName}`,
    fields: [{ key: "comment", label: "发布说明（审批人可见）", type: "textarea", span: 2, placeholder: "如：口径已确认，申请发布上线" }],
    onOk: async (o) => {
      await post("/approvals", { entity_type: entityType, entity_id: entityId, comment: o.comment });
      toast("已提交审批，请在「审批中心」处理");
      closeModal();
      await refreshAll();
      return true;
    },
  });
}

// ---------------------------------------------------------------- 审批中心
let APPROVAL_VIEW = "pending";   // pending 待办 / history 历史

function renderApprovals() {
  document.querySelectorAll("#approval-seg .seg-item").forEach(b =>
    b.classList.toggle("active", b.dataset.view === APPROVAL_VIEW));
  api("/approvals?page=1&page_size=100").then(d => {
    const rows = (d.items || []).filter(a =>
      APPROVAL_VIEW === "pending" ? a.status === "PENDING" : a.status !== "PENDING");
    const statusBadge = a => a.status === "APPROVED" ? `<span class="badge status pub">${APPROVAL_STATUS_LABEL[a.status]}</span>`
      : a.status === "REJECTED" ? `<span class="badge status arch">${APPROVAL_STATUS_LABEL[a.status]}</span>`
      : `<span class="badge status">${APPROVAL_STATUS_LABEL[a.status]}</span>`;
    $("tbl-approvals").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>类型</th><th>动作</th><th>状态</th><th>说明</th><th>提交时间</th><th>审批时间</th><th style="width:150px">操作</th></tr></thead>
      <tbody>${rows.map(a => `<tr>
        <td><code>${esc(a.entity_code)}</code></td><td>${esc(a.entity_name)}</td>
        <td>${ENTITY_TYPE_LABEL[a.entity_type] || a.entity_type}</td>
        <td><span class="tag">发布</span></td>
        <td>${statusBadge(a)}</td>
        <td class="hint-text">${esc(a.comment || "-")}</td>
        <td class="hint-text">${esc(a.created_at)}</td>
        <td class="hint-text">${esc(a.reviewed_at || "-")}</td>
        <td>${a.status === "PENDING" ? `
          <button class="btn-ghost btn-sm" data-approve="${a.id}">同意</button>
          <button class="btn-ghost btn-sm danger" data-reject="${a.id}">驳回</button>` : `<span class="hint-text">已处理</span>`}</td>
      </tr>`).join("") || `<tr><td colspan="9" class="empty">${APPROVAL_VIEW === "pending" ? "暂无待审批事项（原子指标行点击「提交发布」发起）" : "暂无审批历史"}</td></tr>`}</tbody>`;
    $("tbl-approvals").querySelectorAll("[data-approve]").forEach(b => b.onclick = () => approvalReview(Number(b.dataset.approve), "approve"));
    $("tbl-approvals").querySelectorAll("[data-reject]").forEach(b => b.onclick = () => approvalReview(Number(b.dataset.reject), "reject"));
  });
}

function approvalReview(approvalId, action) {
  openModal({
    title: action === "approve" ? "审批同意" : "审批驳回",
    fields: [{ key: "comment", label: "审批意见（可选）", type: "textarea", span: 2,
               placeholder: action === "approve" ? "如：口径无误，同意发布" : "如：口径待确认，请补充说明" }],
    onOk: async (o) => {
      await post(`/approvals/${approvalId}/${action}`, { comment: o.comment });
      toast(action === "approve" ? "已同意，指标发布生效（PUBLISHED）" : "已驳回，实体保持原状态");
      await refreshAll();
    },
  });
}

// ================================================================
// 数据质量与监控：健康度总览 / 质量规则 / 手动检查 / 站内告警
// ================================================================
function renderQuality() {
  renderHealth();
  renderQualityRules();
}

function healthBadge(level) {
  const cls = { green: "pub", yellow: "warn", red: "arch" }[level] || "";
  return `<span class="badge status ${cls}">${HEALTH_LABEL[level] || level}</span>`;
}

function renderHealth() {
  api("/quality/health").then(d => {
    const s = d.summary || {};
    $("health-cards").innerHTML = `
      <div class="sum-card total"><b>${s.total ?? 0}</b><span>模型总数</span></div>
      <div class="sum-card" style="border-left:3px solid #52c41a"><b style="color:#52c41a">${s.green ?? 0}</b><span>健康（绿）</span></div>
      <div class="sum-card" style="border-left:3px solid #faad14"><b style="color:#faad14">${s.yellow ?? 0}</b><span>关注（黄）</span></div>
      <div class="sum-card" style="border-left:3px solid #f5222d"><b style="color:#f5222d">${s.red ?? 0}</b><span>告警（红）</span></div>`;
    $("tbl-health").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>物化状态</th><th>物化表</th><th>行数</th><th>最新分区</th><th>新鲜度</th><th>规则结果</th><th>健康度</th></tr></thead>
      <tbody>${(d.items || []).map(m => `<tr>
        <td><code>${esc(m.code)}</code></td><td>${esc(m.name)}</td>
        <td>${m.materialized ? `<span class="badge status pub">已物化</span>` : `<span class="badge status arch">未物化</span>`}</td>
        <td><code>${esc(m.physical_table || "-")}</code></td>
        <td class="num">${fmt(m.row_count)}</td>
        <td class="hint-text">${esc(m.latest_date || "-")}</td>
        <td>${m.fresh_days === null || m.fresh_days === undefined ? '<span class="hint-text">-</span>'
          : m.fresh_days > 7 ? `<span class="badge status arch">${m.fresh_days} 天</span>`
          : m.fresh_days > 3 ? `<span class="badge status warn">${m.fresh_days} 天</span>`
          : `<span class="badge status pub">${m.fresh_days} 天</span>`}</td>
        <td>${m.rule_total ? `<span class="hint-text">通过 ${m.rule_total - m.rule_failed - m.rule_error} / 失败 ${m.rule_failed} / 异常 ${m.rule_error}</span>` : '<span class="hint-text">未配置</span>'}</td>
        <td>${healthBadge(m.level)}</td>
      </tr>`).join("") || `<tr><td colspan="9" class="empty">暂无下游模型</td></tr>`}</tbody>`;
  });
}

function ruleParamsText(type, params) {
  const p = params || {};
  const map = {
    row_count_min: `行数 ≥ ${p.min_rows}`,
    row_count_change: `波动 ≤ ${p.max_change_pct}%`,
    non_null_rate: `${p.column} 非空率 ≥ ${p.min_rate}%`,
    fresh_days: `最新数据 ≤ ${p.max_days} 天`,
  };
  return map[type] || JSON.stringify(p);
}

function ruleResultBadge(r) {
  if (!r.last_result) return '<span class="hint-text">未检查</span>';
  const cls = { ok: "pub", fail: "warn", error: "arch" }[r.last_result] || "";
  const label = { ok: "通过", fail: "失败", error: "异常" }[r.last_result] || r.last_result;
  return `<span class="badge status ${cls}">${label}</span><span class="hint-text" style="margin-left:6px">${esc(r.last_value ?? "")}${r.last_message ? " " + esc(r.last_message) : ""}</span>`;
}

function renderQualityRules() {
  api("/quality-rules").then(d => {
    $("tbl-quality").innerHTML = `<thead><tr><th>目标模型</th><th>规则类型</th><th>参数</th><th>级别</th><th>状态</th><th>最近检查</th><th>最近结果</th><th style="width:230px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(r => `<tr>
        <td><code>${esc(r.entity_code)}</code></td>
        <td>${RULE_TYPE_LABEL[r.rule_type] || r.rule_type}</td>
        <td class="hint-text">${esc(ruleParamsText(r.rule_type, r.params))}</td>
        <td>${r.severity === "critical" ? `<span class="badge status arch">critical</span>` : `<span class="badge soft">${r.severity}</span>`}</td>
        <td>${r.enabled ? `<span class="badge status pub">启用</span>` : `<span class="badge soft">停用</span>`}</td>
        <td class="hint-text">${esc(r.last_check_at || "-")}</td>
        <td>${ruleResultBadge(r)}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="check" data-id="${r.id}">检查</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${r.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="toggle" data-id="${r.id}">${r.enabled ? "停用" : "启用"}</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${r.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="8" class="empty">暂无质量规则（物化 / 重导成功会自动执行已启用规则）</td></tr>`}</tbody>`;
    $("tbl-quality").querySelectorAll("[data-act='check']").forEach(b => b.onclick = async () => {
      const id = Number(b.dataset.id);
      try {
        const d = await post(`/quality-rules/${id}/check`);
        toast(`检查完成：${d.result}（${d.value ?? ""} ${d.message || ""}）`, d.result === "ok");
        renderQualityRules();
        renderHealth();
      } catch (e) { toast(e.message, false); }
    });
    $("tbl-quality").querySelectorAll("[data-act='edit']").forEach(b => b.onclick = () => qualityRuleForm(Number(b.dataset.id)));
    $("tbl-quality").querySelectorAll("[data-act='toggle']").forEach(b => b.onclick = async () => {
      try {
        const d = await post(`/quality-rules/${b.dataset.id}/toggle`);
        toast(d.enabled ? "规则已启用" : "规则已停用");
        renderQualityRules();
      } catch (e) { toast(e.message, false); }
    });
    $("tbl-quality").querySelectorAll("[data-act='del']").forEach(b => b.onclick = () => confirmDelete("删除该质量规则？", () => del(`/quality-rules/${b.dataset.id}`)));
  });
}

// 质量规则表单：规则类型切换时动态渲染参数区（rule-params-zone）
async function qualityRuleForm(ruleId) {
  let v = { entity_id: "", rule_type: "row_count_min", severity: "warning", enabled: 1, params: {} };
  if (ruleId) {
    const r = (await api("/quality-rules")).items.find(x => x.id === ruleId);
    if (r) v = { entity_id: r.entity_id, rule_type: r.rule_type, severity: r.severity, enabled: r.enabled ? 1 : 0, params: r.params || {} };
  }
  openModal({
    title: ruleId ? "编辑质量规则" : "新建质量规则",
    fields: [
      { key: "entity_id", label: "目标模型（下游模型）", type: "select", required: true, options: DOWNSTREAMS.map(d => ({ value: d.id, label: `${d.code}（${d.name}）` })) },
      { key: "rule_type", label: "规则类型", type: "select", required: true, options: Object.entries(RULE_TYPE_LABEL).map(([k, l]) => ({ value: k, label: l })) },
      { key: "severity", label: "级别", type: "select", options: [{ value: "warning", label: "warning（失败 → 黄色关注）" }, { value: "critical", label: "critical（失败 → 红色告警）" }] },
      { key: "enabled", label: "启用状态", type: "select", options: [{ value: 1, label: "启用（物化/重导后自动检查）" }, { value: 0, label: "停用" }] },
    ],
    value: v,
    hint: "检查方式：物化表 COUNT / COUNT(列非空) / MAX(最新分区) 新鲜度；模型未物化时检查返回「异常」",
    onOk: async (o) => {
      const params = {};
      for (const p of RULE_TYPE_PARAMS[o.rule_type] || []) {
        const el = document.getElementById("p-" + p.key);
        let val = el ? el.value.trim() : "";
        if (p.type === "number") {
          val = Number(val);
          if (isNaN(val)) throw new Error(`请填写参数「${p.label}」`);
        } else if (!val) throw new Error(`请填写参数「${p.label}」`);
        params[p.key] = val;
      }
      const body = { entity_id: Number(o.entity_id), rule_type: o.rule_type, params, severity: o.severity, enabled: Number(o.enabled) };
      if (ruleId) await put(`/quality-rules/${ruleId}`, body);
      else await post("/quality-rules", body);
      await refreshAll();
    },
  });
  const zone = document.createElement("div");
  zone.id = "rule-params-zone";
  $("modal-body").appendChild(zone);
  const buildParams = () => {
    const type = $("f-rule_type").value;
    zone.innerHTML = `<div class="form-grid" style="margin-top:12px">${RULE_TYPE_PARAMS[type].map(p => `
      <div class="field"><label>${p.label} *</label>
        <input id="p-${p.key}" type="${p.type === "number" ? "number" : "text"}" placeholder="${esc(p.placeholder)}" value="${esc(v.params[p.key] ?? "")}"></div>`).join("")}</div>`;
  };
  buildParams();
  $("f-rule_type").onchange = buildParams;
}

// ================================================================
// 调度与运维：周期调度 / 任务实例 / 失败重试
// ================================================================
function renderOps() {
  renderSchedules();
  renderTaskInstances();
}

function renderSchedules() {
  api("/schedules").then(d => {
    $("tbl-schedules").innerHTML = `<thead><tr><th>目标模型</th><th>调度类型</th><th>执行动作</th><th>状态</th><th>上次执行</th><th>下次执行</th><th style="width:230px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(s => `<tr>
        <td><code>${esc(s.entity_code)}</code></td>
        <td>${s.schedule_type === "daily" ? `每天 ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}` : `每 ${s.interval_minutes} 分钟`}</td>
        <td>${s.action === "materialize" ? `<span class="tag">物化</span>` : `<span class="tag agg">重导</span>`}</td>
        <td>${s.enabled ? `<span class="badge status pub">启用</span>` : `<span class="badge soft">停用</span>`}</td>
        <td class="hint-text">${esc(s.last_run_at || "-")}</td>
        <td class="hint-text">${esc(s.next_run_at || "-")}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="run" data-id="${s.id}">立即执行</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${s.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="toggle" data-id="${s.id}">${s.enabled ? "停用" : "启用"}</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${s.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="7" class="empty">暂无调度配置</td></tr>`}</tbody>`;
    $("tbl-schedules").querySelectorAll("[data-act='run']").forEach(b => b.onclick = async () => {
      const id = Number(b.dataset.id);
      try {
        const d = await post(`/schedules/${id}/run`);
        toast(d.status === "SUCCESS" ? "执行成功，已自动触发质量检查" : `执行完成：${d.status}`, d.status === "SUCCESS");
        renderSchedules();
        renderTaskInstances();
      } catch (e) { toast(e.message, false); }
    });
    $("tbl-schedules").querySelectorAll("[data-act='edit']").forEach(b => b.onclick = () => scheduleForm(Number(b.dataset.id)));
    $("tbl-schedules").querySelectorAll("[data-act='toggle']").forEach(b => b.onclick = async () => {
      try {
        const d = await post(`/schedules/${b.dataset.id}/toggle`);
        toast(d.enabled ? "调度已启用" : "调度已停用");
        renderSchedules();
      } catch (e) { toast(e.message, false); }
    });
    $("tbl-schedules").querySelectorAll("[data-act='del']").forEach(b => b.onclick = () => confirmDelete("删除该调度配置？", () => del(`/schedules/${b.dataset.id}`)));
  });
}

async function scheduleForm(id) {
  let v = { entity_id: "", schedule_type: "daily", hour: 2, minute: 0, interval_minutes: 60, action: "materialize", enabled: 1 };
  if (id) {
    const r = (await api("/schedules")).items.find(x => x.id === id);
    if (r) v = { ...v, ...r, enabled: r.enabled ? 1 : 0 };
  }
  openModal({
    title: id ? "编辑调度配置" : "新建调度配置",
    fields: [
      { key: "entity_id", label: "目标模型", type: "select", required: true, options: DOWNSTREAMS.map(d => ({ value: d.id, label: `${d.code}（${d.name}）` })) },
      { key: "schedule_type", label: "调度类型", type: "select", options: [{ value: "daily", label: "每天固定时间（daily）" }, { value: "interval", label: "固定间隔（interval）" }] },
      { key: "hour", label: "小时（daily，0-23）", type: "number" },
      { key: "minute", label: "分钟（daily，0-59）", type: "number" },
      { key: "interval_minutes", label: "间隔分钟（interval）", type: "number" },
      { key: "action", label: "执行动作", type: "select", options: [{ value: "materialize", label: "物化（生成 / 刷新物化表）" }, { value: "reimport", label: "重导（近 3 个月重算）" }] },
      { key: "enabled", label: "启用状态", type: "select", options: [{ value: 1, label: "启用" }, { value: 0, label: "停用" }] },
    ],
    value: v,
    hint: "后台调度器每 30 秒扫描一次到点任务并执行，成功自动触发质量检查；「立即执行」不依赖线程时序",
    onOk: async (o) => {
      const body = {
        entity_id: Number(o.entity_id), schedule_type: o.schedule_type,
        hour: o.schedule_type === "daily" ? Number(o.hour) : 0,
        minute: o.schedule_type === "daily" ? Number(o.minute) : 0,
        interval_minutes: o.schedule_type === "interval" ? Number(o.interval_minutes) : 60,
        action: o.action, enabled: Number(o.enabled),
      };
      if (body.hour > 23 || body.hour < 0) throw new Error("小时需在 0-23");
      if (body.minute > 59 || body.minute < 0) throw new Error("分钟需在 0-59");
      if (body.interval_minutes < 1) throw new Error("间隔需 ≥ 1 分钟");
      if (id) await put(`/schedules/${id}`, body);
      else await post("/schedules", body);
      await refreshAll();
    },
  });
}

function taskStatusBadge(s) {
  const cls = { SUCCESS: "pub", FAILED: "arch", RUNNING: "", PENDING: "", SKIPPED: "" }[s] || "";
  return `<span class="badge status ${cls}">${TASK_STATUS_LABEL[s] || s}</span>`;
}

function taskInstanceResult(i) {
  if (i.error) return "失败：" + i.error;
  const d = i.detail || {};
  if (d.row_count !== undefined) return `写入 ${fmt(d.row_count)} 行`;
  if (d.result) return `${d.result}（${d.value ?? ""} ${d.message || ""}）`;
  if (d.message) return d.message;
  return "-";
}

function renderTaskInstances() {
  const tt = $("ti-type").value, st = $("ti-status").value;
  api(`/task-instances?page=1&page_size=100${tt ? "&task_type=" + tt : ""}${st ? "&status=" + st : ""}`).then(d => {
    $("tbl-task-instances").innerHTML = `<thead><tr><th>ID</th><th>任务</th><th>对象</th><th>触发</th><th>状态</th><th>开始</th><th>结束</th><th>结果</th><th style="width:110px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(i => `<tr>
        <td class="num">${i.id}</td>
        <td>${TASK_TYPE_LABEL[i.task_type] || i.task_type}</td>
        <td><code>${esc(i.entity_code || "-")}</code></td>
        <td>${TRIGGER_LABEL[i.trigger] || i.trigger}</td>
        <td>${taskStatusBadge(i.status)}</td>
        <td class="hint-text">${esc(i.started_at || "-")}</td>
        <td class="hint-text">${esc(i.finished_at || "-")}</td>
        <td class="hint-text" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(taskInstanceResult(i))}">${esc(taskInstanceResult(i))}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="detail" data-id="${i.id}">详情</button>
          ${i.status === "FAILED" ? `<button class="btn-ghost btn-sm" data-act="retry" data-id="${i.id}">重试</button>` : ""}
        </td></tr>`).join("") || `<tr><td colspan="9" class="empty">暂无任务实例（物化 / 重导 / 质量检查会自动记录）</td></tr>`}</tbody>`;
    $("tbl-task-instances").querySelectorAll("[data-act='detail']").forEach(b => b.onclick = () => taskInstanceDetail(Number(b.dataset.id)).catch(e => toast(e.message, false)));
    $("tbl-task-instances").querySelectorAll("[data-act='retry']").forEach(b => b.onclick = () => retryTask(Number(b.dataset.id)));
  });
}

async function taskInstanceDetail(id) {
  const i = await api(`/task-instances/${id}`);
  openModal({
    title: `任务实例 #${i.id} · ${TASK_TYPE_LABEL[i.task_type] || i.task_type}`,
    width: 700,
    fields: [
      { key: "_base", label: "基本信息", type: "pre", span: 2 },
      { key: "_detail", label: "执行明细（JSON）", type: "pre", span: 2 },
      { key: "_error", label: "错误信息", type: "pre", span: 2 },
    ],
    value: {
      _base: `对象：${i.entity_code || "-"}（${ENTITY_TYPE_LABEL[i.entity_type] || i.entity_type}）
触发：${TRIGGER_LABEL[i.trigger] || i.trigger}    状态：${TASK_STATUS_LABEL[i.status] || i.status}
开始：${i.started_at || "-"}    结束：${i.finished_at || "-"}`,
      _detail: JSON.stringify(i.detail || {}, null, 2),
      _error: i.error || "（无）",
    },
    onOk: async () => {},
  });
  $("modal-ok").style.display = "none";
  $("modal-cancel").textContent = "关 闭";
}

// 失败任务重试（按实例类型与参数重放；质量检查返回 {status:"ok", result...}）
async function retryTask(id) {
  if (!(await confirmModal("重试任务", "重试该任务？将按实例类型与参数重新执行", "重 试"))) return;
  try {
    const d = await post(`/task-instances/${id}/retry`);
    const okFlag = d.status !== "FAILED";
    toast(d.status === "ok" ? `重试完成：${d.result}（${d.message || ""}）` : `重试执行：${TASK_STATUS_LABEL[d.status] || d.status}`, okFlag);
    renderTaskInstances();
    renderReimportHistory();
    refreshAlertBadge();
  } catch (e) { toast(e.message, false); }
}

// ================================================================
// 站内告警（通知铃铛）
// ================================================================
async function refreshAlertBadge() {
  const badge = $("alert-badge");
  if (!badge) return;
  try {
    const d = await api("/alerts/unread-count");
    badge.style.display = d.unread ? "" : "none";
    badge.textContent = d.unread;
  } catch { /* 后端不可用时静默 */ }
}

function alertLevelBadge(level) {
  const cls = { info: "", warning: "warn", error: "arch" }[level] || "";
  return `<span class="badge status ${cls}">${ALERT_LEVEL_LABEL[level] || level}</span>`;
}

async function renderAlertList() {
  const list = $("alert-list");
  if (!list) return;
  const d = await api("/alerts?page=1&page_size=30");
  list.innerHTML = (d.items || []).map(a => `<div class="alert-item ${a.read ? "" : "unread"}" data-alert="${a.id}">
      ${alertLevelBadge(a.level)}
      <div class="alert-main">
        <div class="alert-msg">${esc(a.message)}</div>
        <div class="alert-time">${esc(a.created_at)}</div>
      </div>
      ${a.read ? "" : '<span class="alert-dot"></span>'}
    </div>`).join("") || '<div class="alert-empty">暂无通知</div>';
  list.querySelectorAll("[data-alert]").forEach(el => el.onclick = async () => {
    const id = Number(el.dataset.alert);
    try {
      await post(`/alerts/${id}/read`);
      await refreshAlertBadge();
      closeAlertDropdown(); // 点击通知后关闭下拉（避免一直保留在页面上）
    } catch (e) { /* 静默 */ }
  });
}

function toggleAlertDropdown() {
  const dd = $("alert-dropdown");
  if (!dd) return;
  dd.classList.toggle("open");
  if (dd.classList.contains("open")) renderAlertList().catch(() => {});
}

function closeAlertDropdown() {
  const dd = $("alert-dropdown");
  if (dd) dd.classList.remove("open");
}

// ---------------------------------------------------------------- 数据集
const DS_TYPE_LABEL = { downstream_model: "物化表", metric_query: "指标实时查询" };

function renderDatasets() {
  const kw = $("kw-datasets").value.trim();
  api(`/datasets?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-datasets").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>数据源</th><th>来源 / 配置</th><th>粒度</th><th>授权应用</th><th style="width:300px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td>
        <td>${esc(x.name)}</td>
        <td>${x.source_type === "downstream_model"
          ? `<span class="badge status pub">物化表</span>`
          : `<span class="badge status">指标实时查询</span>`}</td>
        <td>${x.source_type === "downstream_model"
          ? esc(x.source_model_name)
          : (x.metric_codes || []).map(c => `<span class="tag agg">${esc(c)}</span>`).join(" ")
            + (x.dim_codes || []).map(c => ` <code>${esc(c)}</code>`).join("")}</td>
        <td>${GRANULARITY_LABEL[x.granularity] || x.granularity}</td>
        <td>${x.granted_app_count > 0
          ? `<span class="tag">${x.granted_app_count} 个应用</span>`
          : '<span class="hint-text">未授权</span>'}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="preview" data-id="${x.id}">预览</button>
          <button class="btn-ghost btn-sm" data-act="grant" data-id="${x.id}">授权</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="7" class="empty">暂无数据集</td></tr>`}</tbody>`;
  });
}

async function datasetForm(id) {
  let v = { code: "", name: "", source_type: "downstream_model",
            source_model_id: DOWNSTREAMS[0]?.id ?? "",
            metric_codes: [], dim_codes: ["dim_city"], granularity: "day", description: "" };
  if (id) v = { ...v, ...(await api(`/datasets/${id}`)) };
  const allMetrics = ["atomic", "derived"].flatMap(t => META[t]);
  openModal({
    title: id ? "编辑数据集" : "新建数据集",
    width: 680,
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 ds_city_daily" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 城市订单日报" },
      { key: "source_type", label: "数据源类型", type: "select", required: true, span: 2,
        options: [{ value: "downstream_model", label: "下游模型物化表（读 dl_ 表，查询性能好）" },
                  { value: "metric_query", label: "指标实时查询（动态 SQL 计算，数据最新）" }] },
      { key: "source_model_id", label: "来源下游模型", type: "select",
        options: DOWNSTREAMS.map(m => ({ value: m.id, label: `${m.name}（${m.code}）` })) },
      { key: "metric_codes", label: "查询指标", type: "multi", span: 2,
        options: allMetrics.map(m => ({ value: m.code, label: `${m.name}（${m.code}）` })) },
      { key: "dim_codes", label: "统计维度", type: "multi", span: 2, options: DIMS.map(d => ({ value: d.code, label: d.name })) },
      { key: "granularity", label: "日期粒度", type: "select", options: Object.entries(GRANULARITY_LABEL).map(([k, l]) => ({ value: k, label: l })) },
      { key: "description", label: "描述", type: "textarea", span: 2 },
    ],
    value: v,
    onOk: async (o) => {
      const body = {
        code: o.code, name: o.name, source_type: o.source_type, description: o.description,
        granularity: o.granularity,
        source_model_id: o.source_type === "downstream_model" ? Number(o.source_model_id) : null,
        metric_codes: o.source_type === "metric_query" ? (o.metric_codes || []) : [],
        dim_codes: o.source_type === "metric_query" ? (o.dim_codes || []) : [],
      };
      if (body.source_type === "downstream_model" && !body.source_model_id) throw new Error("请选择来源下游模型");
      if (body.source_type === "metric_query" && !body.metric_codes.length) throw new Error("请至少选择一个查询指标");
      if (id) await put(`/datasets/${id}`, body);
      else await post("/datasets", body);
      await refreshAll();
    },
  });
  // 数据源类型联动：downstream_model ↔ metric_query 条件字段互斥
  const st = $("f-source_type");
  const toggle = () => {
    const isModel = st.value === "downstream_model";
    [["source_model_id", isModel], ["metric_codes", !isModel], ["dim_codes", !isModel], ["granularity", !isModel]]
      .forEach(([k, show]) => { const el = $("f-" + k); if (el) el.closest(".field").style.display = show ? "" : "none"; });
  };
  st.addEventListener("change", toggle);
  toggle();
}

// 数据集授权弹窗：勾选变化 → 差异调用 grant / revoke
async function datasetGrantModal(id) {
  const d = await api(`/datasets/${id}`);
  const granted = new Set(d.granted_app_ids || []);
  $("modal-title").textContent = `数据集授权 · ${d.name}`;
  $("modal").style.width = "620px";
  $("modal-msg").textContent = "勾选变更后保存：新勾选自动授权，取消勾选自动撤销";
  $("modal-msg").style.color = "var(--text-3)";
  $("modal-ok").style.display = "";
  $("modal-ok").textContent = "保 存";
  $("modal-cancel").textContent = "取 消";
  $("modal-cancel").onclick = closeModal;
  $("modal-body").innerHTML = `<div class="chip-group">${(APPS || []).map(a =>
    `<label class="chip${granted.has(a.id) ? " active" : ""}"><input type="checkbox" value="${a.id}" ${granted.has(a.id) ? "checked" : ""}>${esc(a.name)}（<code>${esc(a.code)}</code>）</label>`).join("") || '<p class="empty">暂无下游应用</p>'}</div>`;
  $("modal-body").querySelectorAll("input").forEach(c => c.onchange = () => c.closest(".chip").classList.toggle("active", c.checked));
  $("modal-backdrop").classList.add("open");
  $("modal-close").onclick = closeModal;
  $("modal-backdrop").onclick = e => { if (e.target === $("modal-backdrop")) closeModal(); };
  $("modal-ok").onclick = async () => {
    const checked = [...$("modal-body").querySelectorAll("input:checked")].map(c => Number(c.value));
    const btn = $("modal-ok");
    btn.disabled = true; btn.textContent = "提交中…";
    try {
      for (const aid of checked) if (!granted.has(aid)) await post(`/datasets/${id}/grant`, { app_id: aid });
      for (const aid of [...granted]) if (!checked.includes(aid)) await del(`/datasets/${id}/grant/${aid}`);
      closeModal();
      toast("授权已更新");
      await refreshAll();
    } catch (e) {
      $("modal-msg").textContent = e.message; $("modal-msg").style.color = "var(--danger)";
    } finally {
      btn.disabled = false; btn.textContent = "保 存";
    }
  };
}

// 数据集预览：物化表直读 / 指标实时查询，弹窗内表格 + 图表
async function datasetPreview(id) {
  const d = await api(`/datasets/${id}`);
  if (d.source_type === "downstream_model") {
    const dm = await api(`/downstream-models/${d.source_model_id}`);
    if (!dm.materialized) { toast(`来源下游模型 ${dm.code} 尚未物化，无法预览`, false); return; }
    const data = await api(`/downstream-models/${d.source_model_id}/data?page=1&page_size=50`);
    const nMetrics = (dm.metrics || []).length;
    datasetPreviewModal(`数据集预览 · ${d.name}（${dm.physical_table} 前 50 行）`,
      data.columns, data.rows, nMetrics,
      `物化表直读 · 共 ${data.total} 行 · 实时性：物化快照`);
  } else {
    const end = new Date(), start = new Date(Date.now() - 30 * 864e5);
    const res = await post("/query", {
      metric_codes: d.metric_codes || [], dim_codes: d.dim_codes || [],
      granularity: d.granularity,
      start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10),
    });
    datasetPreviewModal(`数据集预览 · ${d.name}（近 30 天实时计算）`,
      res.columns, res.rows, (res.summary.metric_names || []).length,
      `指标实时查询 · ${res.rows.length} 行 · 实时性：最新数据`);
  }
}

function datasetPreviewModal(title, cols, rows, nMetrics, hint) {
  $("modal-title").textContent = title;
  $("modal").style.width = "920px";
  $("modal-msg").textContent = "";
  $("modal-ok").style.display = "none";
  $("modal-cancel").textContent = "关 闭";
  $("modal-cancel").onclick = closeModal;
  $("modal-body").innerHTML = `
    <div class="hint-text" style="margin-bottom:10px">${esc(hint)}</div>
    <div class="card" style="box-shadow:none;margin-bottom:12px">
      <div class="chart-wrap" style="height:280px"><div id="pv-chart" class="lineage-graph"></div></div>
    </div>
    <div class="table-wrap"><table id="pv-table"></table></div>`;
  $("modal-backdrop").classList.add("open");
  $("modal-close").onclick = closeModal;
  $("modal-backdrop").onclick = e => { if (e.target === $("modal-backdrop")) closeModal(); };
  renderTable($("pv-table"), cols, rows);
  renderChart(cols, rows, nMetrics, $("pv-chart"));
}

// ---------------------------------------------------------------- 开放 API：下游应用
const APP_STATUS_LABEL = { ENABLED: "启用", DISABLED: "停用" };

function renderApps() {
  const kw = $("kw-apps").value.trim();
  api(`/downstream-apps?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-apps").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>AppKey</th><th>AppSecret</th><th>状态</th><th>累计调用</th><th>数据集</th><th style="width:270px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td>
        <td>${esc(x.name)}</td>
        <td class="key-mono">${esc(x.appkey)} <button class="btn-ghost btn-sm" data-copy="${esc(x.appkey)}">复制</button></td>
        <td class="hint-text">仅创建/重置时可见</td>
        <td>${x.status === "ENABLED" ? `<span class="badge status pub">启用</span>` : `<span class="badge status arch">停用</span>`}</td>
        <td class="num">${x.call_count}</td>
        <td class="num">${x.dataset_count}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="toggle" data-id="${x.id}">${x.status === "ENABLED" ? "停用" : "启用"}</button>
          <button class="btn-ghost btn-sm" data-act="reset" data-id="${x.id}">重置密钥</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="8" class="empty">暂无下游应用</td></tr>`}</tbody>`;
  });
}

async function appForm(id) {
  let v = { code: "", name: "", description: "", status: "ENABLED" };
  if (id) v = { ...v, ...(await api(`/downstream-apps/${id}`)) };
  openModal({
    title: id ? "编辑下游应用" : "新建下游应用",
    fields: [
      { key: "code", label: "编码", type: "text", required: true, placeholder: "如 report_bi" },
      { key: "name", label: "名称", type: "text", required: true, placeholder: "如 报表看板系统" },
      { key: "status", label: "状态", type: "select", options: Object.entries(APP_STATUS_LABEL).map(([k, l]) => ({ value: k, label: l })) },
      { key: "description", label: "描述", type: "textarea", span: 2, placeholder: "如 BI 报表 / 看板（消费数据集）" },
    ],
    value: v,
    onOk: async (o) => {
      if (id) {
        await put(`/downstream-apps/${id}`, o);
      } else {
        const d = await post("/downstream-apps", o);
        APP_SECRETS[d.id] = d.appsecret;
        showCredentials(d.appkey, d.appsecret);
      }
      await refreshAll();
    },
  });
}

// 密钥展示弹窗（仅创建/重置时展示一次）
function showCredentials(appkey, appsecret) {
  $("modal-title").textContent = "应用密钥 · 请妥善保管";
  $("modal").style.width = "640px";
  $("modal-msg").textContent = "";
  $("modal-ok").style.display = "none";
  $("modal-cancel").textContent = "我知道了";
  $("modal-cancel").onclick = closeModal;
  $("modal-body").innerHTML = `
    <div class="field" style="margin-bottom:14px"><label>AppKey</label>
      <div style="display:flex;gap:8px;align-items:center">
        <code style="flex:1;padding:8px;word-break:break-all">${esc(appkey)}</code>
        <button class="btn-ghost btn-sm" data-copy="${esc(appkey)}">复制</button></div></div>
    <div class="field"><label>AppSecret <span class="hint-text">仅本次展示，请妥善保管（存储于应用内，勿暴露到前端）</span></label>
      <div style="display:flex;gap:8px;align-items:center">
        <code style="flex:1;padding:8px;word-break:break-all">${esc(appsecret)}</code>
        <button class="btn-ghost btn-sm" data-copy="${esc(appsecret)}">复制</button></div></div>
    <p class="hint-text" style="margin-top:12px">调用方式：请求头携带 X-App-Key / X-App-Secret 访问 /openapi/v1/datasets/&lt;code&gt;/data</p>`;
  $("modal-backdrop").classList.add("open");
  $("modal-close").onclick = closeModal;
  $("modal-backdrop").onclick = e => { if (e.target === $("modal-backdrop")) closeModal(); };
}

async function appResetSecret(id) {
  const d = await post(`/downstream-apps/${id}/reset-secret`);
  APP_SECRETS[id] = d.appsecret;
  showCredentials(d.appkey, d.appsecret);
  await refreshAll();
}

// ---------------------------------------------------------------- 开放 API：调用演示 + 用量统计
function renderOpenapi() {
  renderApps();
  renderApiStats();
  renderApiDemo();
}

function renderApiDemo() {
  const sel = $("demo-app");
  const prev = sel.value;
  sel.innerHTML = APPS.map(a => `<option value="${a.id}">${esc(a.name)}（${esc(a.code)}）</option>`).join("") || '<option value="">（暂无应用）</option>';
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  sel.onchange = loadDemoDatasets;
  loadDemoDatasets();
}

async function loadDemoDatasets() {
  const app = APPS.find(a => a.id === Number($("demo-app").value));
  const dsSel = $("demo-dataset");
  if (!app) {
    dsSel.innerHTML = '<option value="">（请先创建并授权应用）</option>';
    updateDemoCurl();
    return;
  }
  const detail = await api(`/downstream-apps/${app.id}`);
  const list = detail.datasets || [];
  dsSel.innerHTML = list.map(d => `<option value="${d.code}">${esc(d.name)}（${esc(d.code)}）</option>`).join("") || '<option value="">（该应用暂无授权数据集）</option>';
  dsSel.onchange = updateDemoCurl;
  updateDemoCurl();
}

function demoSecretFor(app) {
  if (!app) return "";
  return APP_SECRETS[app.id] || ($("demo-secret") && $("demo-secret").value) || "";
}

function updateDemoCurl() {
  const app = APPS.find(a => a.id === Number($("demo-app").value));
  const code = $("demo-dataset").value;
  const limit = $("demo-limit").value || 20;
  if (!app || !code) { $("demo-curl").textContent = "// 选择应用与数据集后自动生成调用示例"; return; }
  const secret = demoSecretFor(app);
  if ($("demo-secret") && APP_SECRETS[app.id] && !$("demo-secret").value) $("demo-secret").value = APP_SECRETS[app.id];
  $("demo-curl").textContent =
`# 下游系统调用示例（数据集 ${code}，AppKey=${app.appkey.slice(0, 8)}…）
curl -s -H "X-App-Key: ${app.appkey}" \\
     -H "X-App-Secret: ${secret || "<AppSecret>"}" \\
     "http://127.0.0.1:8000/openapi/v1/datasets/${code}/data?page=1&page_size=${limit}"`;
}

async function callDemo() {
  const app = APPS.find(a => a.id === Number($("demo-app").value));
  const code = $("demo-dataset").value;
  const limit = $("demo-limit").value || 20;
  if (!app || !code) { toast("请选择应用与数据集", false); return; }
  const secret = demoSecretFor(app);
  if (!secret) { toast("请先创建/重置应用以获取 AppSecret，或在输入框粘贴", false); return; }
  try {
    const r = await fetch(`/openapi/v1/datasets/${encodeURIComponent(code)}/data?page=1&page_size=${limit}`, {
      headers: { "X-App-Key": app.appkey, "X-App-Secret": secret },
    });
    const body = await r.json();
    $("demo-result").textContent = JSON.stringify(body, null, 2);
    if (r.ok && body.code === 0) {
      $("demo-result-hint").textContent = `${body.data.rows.length} 行 · 共 ${body.data.total} 行 · ${body.data.columns.length} 列`;
      toast("调用成功（已记入调用日志）");
    } else {
      $("demo-result-hint").textContent = "";
      toast(`调用失败：${body.message}`, false);
    }
    renderApiStats();
  } catch (e) {
    $("demo-result").textContent = "// 网络错误：" + e.message;
  }
}

async function renderApiStats() {
  const [stats, logs] = await Promise.all([
    api("/openapi/stats"), api("/openapi/logs?page=1&page_size=20"),
  ]);
  const activeApps = (stats.by_app || []).filter(a => a.calls > 0).length;
  $("api-stats-cards").innerHTML = `
    <div class="sum-card total"><b>${stats.total_calls}</b><span>总调用次数</span></div>
    <div class="sum-card total"><b>${fmt(stats.total_rows)}</b><span>累计返回行数</span></div>
    <div class="sum-card total"><b>${activeApps}</b><span>活跃应用</span></div>`;
  $("tbl-api-by-app").innerHTML = `<thead><tr><th>应用</th><th>调用次数</th><th>返回行数</th></tr></thead><tbody>` +
    (stats.by_app || []).map(a => `<tr><td>${esc(a.app_name)}</td><td class="num">${a.calls}</td><td class="num">${fmt(a.rows)}</td></tr>`).join("") +
    `</tbody>`;
  $("tbl-api-by-dataset").innerHTML = `<thead><tr><th>数据集</th><th>调用次数</th><th>返回行数</th></tr></thead><tbody>` +
    (stats.by_dataset || []).map(d => `<tr><td>${esc(d.dataset_name)}</td><td class="num">${d.calls}</td><td class="num">${fmt(d.rows)}</td></tr>`).join("") +
    `</tbody>`;
  $("tbl-api-logs").innerHTML = `<thead><tr><th>时间</th><th>应用</th><th>数据集</th><th>返回行数</th><th>耗时(ms)</th><th>状态</th></tr></thead><tbody>` +
    (logs.items || []).map(l => `<tr>
      <td class="key-mono">${esc(l.called_at)}</td><td>${esc(l.app_name)}</td><td>${esc(l.dataset_name)}</td>
      <td class="num">${l.row_count}</td><td class="num">${l.duration_ms}</td>
      <td>${l.status === "success" ? `<span class="badge status pub">成功</span>` : `<span class="badge status arch">${esc(l.status)}</span>`}</td></tr>`).join("") +
    `</tbody>`;
}

// ---------------------------------------------------------------- 血缘（指标血缘 + 表血缘双视图）
function renderLineage() {
  document.querySelectorAll("#lineage-view-switch .seg-item")
    .forEach(b => b.classList.toggle("active", b.dataset.view === LINEAGE_VIEW));
  if (LINEAGE_VIEW === "table") return renderTableLineage();
  const code = $("lineage-select").value;
  const el = $("lineage-graph");
  if (!code) { el.innerHTML = `<p class="empty">请选择指标</p>`; return; }
  api(`/lineage/${code}`).then(g => {
    const LEVEL = { table: 0, field: 1, atomic: 2, derived: 3, composite: 4 };
    const STYLE = {
      table: ["#f1f5f9", "#475569", "物理表"], field: ["#eef2ff", "#6366f1", "物理字段"],
      atomic: ["#eff6ff", "#2563eb", "原子指标"], derived: ["#ecfdf5", "#059669", "派生指标"],
      composite: ["#fffbeb", "#d97706", "复合指标"],
    };
    renderGraph(el, g, LEVEL, STYLE);
  }).catch(e => { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; });
}

function renderTableLineage() {
  const el = $("lineage-graph");
  api("/lineage/tables").then(g => {
    // 物化表（table:dl_*）位于血缘链末端，单独一列展示
    const LEVEL = { table: 0, logical_model: 1, downstream_model: 2, materialized: 3 };
    const STYLE = {
      table: ["#f1f5f9", "#475569", "物理表"],
      logical_model: ["#eef2ff", "#6366f1", "逻辑模型"],
      downstream_model: ["#ecfdf5", "#059669", "下游模型"],
      materialized: ["#fff1f5", "#db2777", "物化表"],
    };
    const typeOf = n => n.id.startsWith("table:dl_") ? "materialized" : n.type;
    renderGraph(el, g, LEVEL, STYLE, typeOf);
  }).catch(e => { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; });
}

// 通用血缘图渲染：分层列布局 + 贝塞尔连线 + 列头图例
function renderGraph(el, g, LEVEL, STYLE, typeOf = n => n.type) {
  const nodes = g.nodes.map(n => ({ ...n, level: LEVEL[typeOf(n)] ?? 99 }));
  const groups = {};
  nodes.forEach(n => (groups[n.level] = groups[n.level] || []).push(n));
  const nodeW = 168, nodeH = 44, colGap = 60, rowGap = 22, topPad = 34;
  const maxCount = Math.max(1, ...Object.values(groups).map(v => v.length));
  const W = Object.keys(groups).length * (nodeW + colGap) + 60;
  const H = maxCount * (nodeH + rowGap) + topPad + 30;
  const pos = {};
  Object.entries(groups).forEach(([lv, group]) => {
    const x = 30 + Number(lv) * (nodeW + colGap);
    const blockH = group.length * (nodeH + rowGap) - rowGap;
    const y0 = topPad + (H - topPad - 30 - blockH) / 2;
    group.forEach((n, i) => (pos[n.id] = { x, y: y0 + i * (nodeH + rowGap) }));
  });
  const svg = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><title>血缘</title>`];
  svg.push(`<defs><marker id="lh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`);
  Object.entries(groups).forEach(([lv, group]) => {
    const x = 30 + Number(lv) * (nodeW + colGap);
    svg.push(`<text x="${x}" y="18" font-size="11" fill="#94a3b8">${STYLE[typeOf(group[0])][2]}</text>`);
  });
  g.edges.forEach(e => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return;
    const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2;
    const mx = (x1 + x2) / 2;
    svg.push(`<path class="edge-path" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" marker-end="url(#lh)"/>`);
  });
  nodes.forEach(n => {
    const [fill, stroke] = STYLE[typeOf(n)];
    const p = pos[n.id];
    svg.push(`<g class="lg-node"><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>` +
      `<text x="${p.x + 12}" y="${p.y + nodeH / 2 - 6}" font-size="12.5" font-weight="500" fill="${stroke}">${esc(n.label)}</text>` +
      `<text x="${p.x + 12}" y="${p.y + nodeH / 2 + 13}" font-size="10.5" fill="${stroke}" opacity="0.7">${esc(n.code)}</text></g>`);
  });
  svg.push("</svg>");
  el.innerHTML = svg.join("");
}

// ---------------------------------------------------------------- 事件绑定
function bindEvents() {
  // 导航与面板
  document.querySelectorAll(".nav-item").forEach(n =>
    n.onclick = e => { e.preventDefault(); switchTab(n.dataset.tab); });

  // 查询
  $("btn-query").onclick = runQuery;
  $("btn-copy-sql").onclick = () => {
    const sql = $("sql-preview").textContent;
    navigator.clipboard?.writeText(sql).then(() => toast("SQL 已复制")).catch(() => toast("复制失败", false));
  };
  $("btn-export").onclick = exportExcel;

  // 主题域
  $("btn-new-domain").onclick = listenerWrap(() => domainForm(null));
  $("tbl-domains").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") domainForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该主题域？", () => del(`/domains/${id}`));
  });

  // 业务过程
  $("btn-new-process").onclick = listenerWrap(() => processForm());
  $("tbl-processes").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") processForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该业务过程？", () => del(`/processes/${id}`));
  });

  // 原子指标
  $("btn-new-atomic").onclick = listenerWrap(() => atomicForm());
  $("tbl-atomics").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") atomicForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该原子指标？", () => del(`/atomic-metrics/${id}`));
    else if (btn.dataset.act === "versions") versionsModal("atomic_metric", id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "impact") impactModal("atomic_metric", id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "status") {
      const cur = (META.atomic.find(m => m.id === id) || {}).status;
      if (cur === "PUBLISHED") {
        // 已发布 → 直接归档（现有行为不变）
        post(`/atomic-metrics/${id}/status`, { status: "ARCHIVED" }).then(refreshAll).catch(e => toast(e.message, false));
      } else {
        // 草稿/已归档 → 提交发布走审批流
        const m = META.atomic.find(m => m.id === id) || {};
        submitApproval("atomic_metric", id, m.name || "");
      }
    }
  });

  // 维度
  $("btn-new-dim").onclick = listenerWrap(() => dimForm());
  $("tbl-dims").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "attrs") attrManager(id);
    else if (btn.dataset.act === "edit") dimForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该维度？", () => del(`/dimensions/${id}`));
    else if (btn.dataset.act === "versions") versionsModal("dimension", id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "impact") impactModal("dimension", id).catch(err => toast(err.message, false));
  });

  // 派生
  $("btn-new-derived").onclick = listenerWrap(() => derivedForm());
  $("tbl-derived").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") derivedForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该派生指标？（被复合指标引用将拒绝）", () => del(`/derived-metrics/${id}`));
    else if (btn.dataset.act === "sql") {
      api(`/derived-metrics/${id}/sql-preview`).then(d => sqlPreviewModal(`SQL 预览 · ${d.metric_name}`, d.sql, d.params)).catch(e => toast(e.message, false));
    }
    else if (btn.dataset.act === "versions") versionsModal("derived_metric", id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "impact") impactModal("derived_metric", id).catch(err => toast(err.message, false));
  });

  // 复合
  $("btn-new-composite").onclick = listenerWrap(() => compositeForm());
  $("tbl-composites").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") compositeForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该复合指标？", () => del(`/composite-metrics/${id}`));
    else if (btn.dataset.act === "sql") {
      api(`/composite-metrics/${id}/sql-preview`).then(d => sqlPreviewModal("SQL 预览 · " + d.metric_name, d.sql, d.params)).catch(e => toast(e.message, false));
    }
    else if (btn.dataset.act === "versions") versionsModal("composite_metric", id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "impact") impactModal("composite_metric", id).catch(err => toast(err.message, false));
  });

  // 逻辑模型
  $("btn-new-model").onclick = listenerWrap(() => modelForm());
  $("tbl-models").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") modelForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该逻辑模型？", () => del(`/logical-models/${id}`));
    else if (btn.dataset.act === "sql") {
      api(`/logical-models/${id}`).then(d => sqlPreviewModal("逻辑模型 SQL · " + d.name, d.generated_sql)).catch(e => toast(e.message, false));
    }
    else if (btn.dataset.act === "versions") versionsModal("logical_model", id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "impact") impactModal("logical_model", id).catch(err => toast(err.message, false));
  });

  // 下游模型
  $("btn-new-downstream").onclick = listenerWrap(() => downstreamForm());
  $("tbl-downstreams").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") downstreamForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该下游模型？（已物化将先 DROP 物化表）", () => del(`/downstream-models/${id}`));
    else downstreamOp(btn);
  });

  // 任务重导：对象切换 → 刷新血缘与计划；生成计划 / 执行选中
  $("reimport-type").onchange = () => fillReimportObjects($("reimport-type").value, false);
  $("reimport-object").onchange = loadReimportImpact;
  $("btn-reimport-plan").onclick = listenerWrap(genReimportPlan);
  $("btn-reimport-execute").onclick = listenerWrap(execReimportPlan);
  $("btn-reimport-history-refresh").onclick = renderReimportHistory;
  $("btn-reimport-all").onclick = () => {
    const checks = [...document.querySelectorAll(".ri-check")];
    const allOn = checks.every(c => c.checked);
    checks.forEach(c => { c.checked = !allOn; });
    $("btn-reimport-all").textContent = allOn ? "全选" : "全不选";
  };

  // 数据集
  $("btn-new-dataset").onclick = listenerWrap(() => datasetForm());
  $("tbl-datasets").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") datasetForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该数据集？（同时撤销全部授权）", () => del(`/datasets/${id}`));
    else if (btn.dataset.act === "grant") datasetGrantModal(id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "preview") datasetPreview(id).catch(err => toast(err.message, false));
  });

  // 开放 API：下游应用
  $("btn-new-app").onclick = listenerWrap(() => appForm());
  $("tbl-apps").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "edit") appForm(id);
    else if (btn.dataset.act === "del") confirmDelete("删除该应用？（其调用日志一并清除）", () => del(`/downstream-apps/${id}`));
    else if (btn.dataset.act === "reset") appResetSecret(id).catch(err => toast(err.message, false));
    else if (btn.dataset.act === "toggle") {
      const app = APPS.find(a => a.id === id);
      const next = app.status === "ENABLED" ? "DISABLED" : "ENABLED";
      put(`/downstream-apps/${id}`, { code: app.code, name: app.name, description: app.description, status: next })
        .then(() => { toast(next === "DISABLED" ? "已停用（调用将返回 401）" : "已启用"); refreshAll(); })
        .catch(err => toast(err.message, false));
    }
  });
  // 密钥复制按钮（全局委托，覆盖应用列表 / 密钥弹窗）
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-copy]");
    if (b) copyText(b.dataset.copy, "密钥已复制");
  });

  // 开放 API：调用演示
  $("btn-demo-call").onclick = callDemo;
  $("demo-limit").addEventListener("change", updateDemoCurl);
  if ($("demo-secret")) $("demo-secret").addEventListener("input", updateDemoCurl);

  // 血缘
  $("lineage-select").onchange = renderLineage;
  document.querySelectorAll("#lineage-view-switch .seg-item").forEach(b =>
    b.onclick = () => { LINEAGE_VIEW = b.dataset.view; renderLineage(); });

  // 各列表搜索（回车触发）
  ["domains", "processes", "atomics", "dims", "derived", "composites", "downstreams", "datasets", "apps"].forEach(tab => {
    const el = $("kw-" + tab);
    el.addEventListener("keydown", e => { if (e.key === "Enter") switchTab(tab); });
  });

  // 审批中心：待办 / 历史切换
  document.querySelectorAll("#approval-seg .seg-item").forEach(b =>
    b.onclick = () => { APPROVAL_VIEW = b.dataset.view; renderApprovals(); });

  // 质量监控
  $("btn-health-refresh").onclick = () => { renderHealth(); renderQualityRules(); };
  $("btn-new-quality").onclick = listenerWrap(() => qualityRuleForm(null));

  // 任务运维
  $("btn-new-schedule").onclick = listenerWrap(() => scheduleForm(null));
  $("btn-ti-refresh").onclick = renderTaskInstances;
  $("ti-type").onchange = renderTaskInstances;
  $("ti-status").onchange = renderTaskInstances;

  // 通知铃铛：点击开合（阻止冒泡，点击外部关闭）
  $("btn-alerts").onclick = e => { e.stopPropagation(); toggleAlertDropdown(); };
  $("btn-alerts-close").onclick = e => { e.stopPropagation(); closeAlertDropdown(); };
  $("btn-alerts-read-all").onclick = async e => {
    e.stopPropagation();
    try {
      const d = await post("/alerts/read-all");
      toast(`已读 ${d.updated} 条通知`);
      await renderAlertList();
      await refreshAlertBadge();
    } catch (err) { toast(err.message, false); }
  };
  document.addEventListener("click", e => {
    const dd = $("alert-dropdown");
    if (dd && dd.classList.contains("open") && !e.target.closest(".bell-wrap")) closeAlertDropdown();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeAlertDropdown();
  });
}

// ---------------------------------------------------------------- 启动
async function init() {
  try {
    await loadMeta();
    fillAllSelects();
    bindEvents();
    // 默认时间范围（过去 7 天）
    const end = new Date(), start = new Date(Date.now() - 7 * 864e5);
    $("start-date").value = start.toISOString().slice(0, 10);
    $("end-date").value = end.toISOString().slice(0, 10);
    await runQuery();
  } catch (e) {
    $("page-subtitle").textContent = "加载失败：" + e.message;
  }
}

init();