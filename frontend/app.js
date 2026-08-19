/* 统一指标维度管理平台 Demo — 前端逻辑
   覆盖：统一指标查询（动态 SQL + 图表 + Excel 导出）/ 全量元数据 CRUD /
   派生规则引擎（筛选条件构建器）/ 逻辑模型 JOIN 配置 / 血缘追溯 */
const API = "/api/v1";

const TYPE_LABEL = { atomic: "原子指标", derived: "派生指标", composite: "复合指标" };
const PERIOD_LABEL = { "1d": "最近1天", "7d": "最近7天", "30d": "最近30天", "90d": "最近90天", ytd: "年初至今", custom: "自定义" };
const STATUS_LABEL = { DRAFT: "草稿", PUBLISHED: "已发布", ARCHIVED: "已归档" };
const FILTER_OPS = ["=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN", "BETWEEN", "LIKE"];
const AGG_FUNCTIONS = ["SUM", "COUNT", "AVG", "MAX", "MIN", "COUNT_DISTINCT"];
const JOIN_TYPES = ["SINGLE", "JOIN"];

// 全局状态（缓存，变更后刷新）
let META = { atomic: [], derived: [], composite: [] };
let DIMS = [];
let DOMAINS = [];
let PROCESSES = [];
let PHYSICAL_TABLES = [];
let CURRENT_TAB = "query";
let LAST_QUERY = null;

// ---------------------------------------------------------------- 工具函数
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(v) {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") {
    if (Math.abs(v) < 1 && v !== 0) return (v * 100).toFixed(2) + "%";
    return v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
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
// type: text/textarea/number/select/multi(checkbox 组)/dims/filters/joins/status/pre(code)
let _modalResolve = null;

function openModal({ title, fields = [], value = {}, width = 560, onOk }) {
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
      default: {
        const inp = document.createElement("input");
        inp.type = f.type === "number" ? "number" : "text";
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
    out._refs = [...document.querySelectorAll("#f-refs input:checked")].map(c => c.value);
    const btn = $("modal-ok");
    btn.disabled = true; btn.textContent = "提交中…";
    try {
      await onOk(out, value);
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
  const [overview, metrics, dims, domains, processes, models] = await Promise.all([
    api("/overview"), api("/metrics"), api("/dimensions"),
    api("/domains?page_size=100"), api("/processes"), api("/logical-models"),
  ]);
  META = metrics;
  DIMS = dims;
  DOMAINS = domains.items || domains;
  PROCESSES = processes;
  LOGICAL_MODELS = models;
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
    ["logical_models", "逻辑模型"],
  ].map(([k, label]) => `<div class="overview-item"><b>${o[k]}</b><span>${label}</span></div>`).join("");
}

async function refreshAll() {
  await loadMeta();
  fillAllSelects();
  switchTab(CURRENT_TAB);
}

// ---------------------------------------------------------------- 全局渲染
const TITLES = {
  query: ["统一指标查询", "指标名称 + 统计维度 + 时间范围 → 自动生成并执行查询，口径一致"],
  domains: ["主题域", "业务领域的高层划分，用于组织管理指标和维度"],
  processes: ["业务过程", "企业活动过程中不可拆分的事件，是指标定义的基础"],
  atomics: ["原子指标", "业务过程的度量值，由「业务过程 + 度量方式」构成，不可再拆分"],
  dims: ["维度与维度属性", "观察和分析数据的角度，属性的统一定义和管理"],
  derived: ["派生指标", "原子指标 + 修饰词（时间周期 / 统计粒度 / 筛选条件）派生为业务指标"],
  composites: ["复合指标", "基于派生指标的四则运算，如 客单价 = 支付金额 ÷ 支付笔数"],
  models: ["逻辑模型", "将物理表映射为逻辑模型，屏蔽底层表结构差异（P1）"],
  lineage: ["指标血缘追溯", "从指标定义到物理字段的完整链路：影响分析 + 根因追溯（P2）"],
};

function switchTab(tab) {
  CURRENT_TAB = tab;
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
  else if (tab === "models") renderModels();
  else if (tab === "lineage") renderLineage();
}

function fillAllSelects() {
  // 查询页指标下拉
  const sel = $("metric-select");
  if (!sel) return;
  sel.innerHTML = ["atomic", "derived", "composite"].map(t =>
    `<optgroup label="${TYPE_LABEL[t]}">${META[t].map(m =>
      `<option value="${m.code}">${esc(m.name)}（${esc(m.code)}）</option>`).join("")}</optgroup>`).join("");
  if (!sel.value) { for (const o of sel.options) { if (o.value) { sel.value = o.value; break; } } }

  // 维度勾选（查询页 + 新建派生
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
  const body = {
    metric_code: $("metric-select").value,
    dim_codes: [...$("dim-chips").querySelectorAll("input:checked")].map(c => c.value),
    start_date: $("start-date").value || null,
    end_date: $("end-date").value || null,
  };
  LAST_QUERY = body;
  try {
    const d = await post("/query", body);
    const s = d.summary;
    $("summary-cards").innerHTML = `
      <div class="sum-card"><b>${esc(s.metric_name)}</b><span>${TYPE_LABEL[s.metric_type]}</span></div>
      <div class="sum-card total"><b>${s.row_count}</b><span>分组行数（口径一致）</span></div>
      <div class="sum-card total"><b>${fmt(s.total)}</b><span>合计</span></div>
      <div class="sum-card avg"><b>${fmt(s.avg)}</b><span>均值</span></div>`;
    $("result-hint").textContent = `${d.columns.length - 1} 个统计维度 · ${s.row_count} 行`;
    renderTable($("result-table"), d.columns, d.rows);
    renderChart(d.columns, d.rows);
    $("sql-preview").innerHTML = "<code>" + esc(d.sql) + "</code>";
  } catch (e) {
    $("summary-cards").innerHTML = "";
    $("result-table").innerHTML = `<tr><td class="empty">${esc(e.message)}</td></tr>`;
    $("chart").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    $("sql-preview").innerHTML = "<code>// " + esc(e.message) + "</code>";
  }
}

function renderTable(el, cols, rows) {
  // 列顺序约定：metric_value 在最前，其余为维度列
  const dims = cols.slice(1);
  const head = `<thead><tr>${dims.map(c => `<th>${esc(c)}</th>`).join("")}<th>指标值</th></tr></thead>`;
  const body = rows.map(r => {
    const dimsTd = dims.map((c, i) => `<td>${esc(r[i + 1] ?? "-")}</td>`).join("");
    return `<tr>${dimsTd}<td class="num" style="font-weight:600">${fmt(r[0])}</td></tr>`;
  }).join("");
  el.innerHTML = head + `<tbody>${body || `<tr><td colspan="${Math.max(cols.length, 1)}" class="empty">无数据</td></tr>`}</tbody>`;
}

function renderChart(cols, rows) {
  const el = $("chart");
  if (!rows.length || cols.length < 2) {
    el.innerHTML = `<p class="empty">无维度分组，不绘制图表</p>`;
    return;
  }
  const data = rows.map(r => ({ label: r.slice(1).join(" / "), value: r[0] })).filter(d => d.value !== null).slice(0, 12);
  const W = 560, barH = 26, gap = 10, pad = 110;
  const H = Math.max(data.length, 1) * (barH + gap) + 10;
  if (!data.length) { el.innerHTML = `<p class="empty">无数据</p>`; return; }
  const max = Math.max(...data.map(d => d.value));
  const svg = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><title>指标可视化</title>`];
  data.forEach((d, i) => {
    const y = i * (barH + gap) + 5;
    const w = max ? (W - pad - 70) * (d.value / max) : 0;
    svg.push(`<text x="${pad - 8}" y="${y + barH / 2}" text-anchor="end" dominant-baseline="central" font-size="12" fill="#64748b">${esc(d.label)}</text>`);
    svg.push(`<rect x="${pad}" y="${y}" width="${Math.max(w, 2)}" height="${barH}" rx="4" fill="#2563eb" opacity="${0.55 + 0.45 * (d.value / max)}"/>`);
    svg.push(`<text x="${pad + Math.max(w, 2) + 8}" y="${y + barH / 2}" dominant-baseline="central" font-size="12" fill="#1e293b">${fmt(d.value)}</text>`);
  });
  svg.push("</svg>");
  el.innerHTML = svg.join("");
}

function exportExcel() {
  if (!LAST_QUERY) { toast("请先执行一次查询", false); return; }
  const q = LAST_QUERY;
  const params = new URLSearchParams({ metric_code: q.metric_code, dim_codes: q.dim_codes.join(",") });
  if (q.start_date) params.set("start_date", q.start_date);
  if (q.end_date) params.set("end_date", q.end_date);
  const a = document.createElement("a");
  a.href = `${API}/query/export?${params}`;
  a.download = `metric_${q.metric_code}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------- 通用删除/确认
async function confirmDelete(message, fn) {
  if (!window.confirm(message)) return;
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
function renderAtomics() {
  const kw = $("kw-atomics").value.trim();
  api(`/atomic-metrics?page=1&page_size=100${kw ? "&keyword=" + encodeURIComponent(kw) : ""}`).then(d => {
    $("tbl-atomics").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>业务过程</th><th>聚合方式</th><th>物理字段</th><th>单位</th><th>状态</th><th style="width:240px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.process_name)}</td>
        <td><span class="tag agg">${x.agg_function}</span></td>
        <td><span class="tag">${esc(x.physical_table)}.${esc(x.physical_field)}</span></td>
        <td>${esc(x.unit)}</td>
        <td>${statusBadge(x.status)}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="status" data-id="${x.id}">${x.status === "PUBLISHED" ? "归档" : "发布"}</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="8" class="empty">暂无原子指标</td></tr>`}</tbody>`;
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
    ],
    value: v,
    onOk: async (o) => {
      if (id) await put(`/atomic-metrics/${id}`, o);
      else await post("/atomic-metrics", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 维度 + 属性
function renderDims() {
  const kw = $("kw-dims").value.trim();
  api(`/dimensions${kw ? "?keyword=" + encodeURIComponent(kw) : ""}`).then(list => {
    $("tbl-dims").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>主题域</th><th>物理表</th><th>关联键</th><th>属性</th><th style="width:260px">操作</th></tr></thead>
      <tbody>${(list || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.domain_name)}</td>
        <td><span class="tag">${esc(x.physical_table)}</span></td>
        <td><code>${esc(x.join_field)}</code></td>
        <td>${(x.attributes || []).map(a => `<span class="tag attr" title="${esc(a.physical_field)}">${esc(a.name)}</span>`).join("") || '<span class="hint-text">-</span>'}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="attrs" data-id="${x.id}">属性</button>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm danger" data-act="del" data-id="${x.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="7" class="empty">暂无维度</td></tr>`}</tbody>`;
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
    ],
    value: v,
    onOk: async (o) => {
      if (id) await put(`/dimensions/${id}`, o);
      else await post("/dimensions", o);
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
    $("tbl-derived").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>原子指标</th><th>时间周期</th><th>统计粒度</th><th>业务限定</th><th>状态</th><th style="width:240px">操作</th></tr></thead>
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
    ],
    value: v,
    onOk: async (o) => {
      if (id) await put(`/derived-metrics/${id}`, o);
      else await post("/derived-metrics", o);
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
    $("tbl-composites").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>计算表达式</th><th>引用指标</th><th>单位</th><th style="width:240px">操作</th></tr></thead>
      <tbody>${(d.items || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td>
        <td><code class="flt">${esc(x.expression)}</code></td>
        <td>${(x.ref_codes || []).map(c => `<span class="tag agg">${esc(c)}</span>`).join(" ")}</td>
        <td>${esc(x.unit)}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="sql" data-id="${x.id}">SQL</button>
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
    ],
    value: v,
    onOk: async (o) => {
      const refs = o._refs;
      for (const r of refs) {
        if (!o.expression.includes(r)) { throw new Error(`表达式未引用所选指标 ${r}`); }
      }
      delete o._refs;
      if (id) await put(`/composite-metrics/${id}`, o);
      else await post("/composite-metrics", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 逻辑模型
function renderModels() {
  api("/logical-models").then(list => {
    $("tbl-models").innerHTML = `<thead><tr><th>编码</th><th>名称</th><th>主题域</th><th>物理表</th><th>JOIN 类型</th><th>JOIN 表数</th><th style="width:240px">操作</th></tr></thead>
      <tbody>${(list || []).map(x => `<tr>
        <td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.domain_name)}</td>
        <td><span class="tag">${esc(x.physical_table)}</span></td>
        <td>${x.join_type === "JOIN" ? `<span class="badge status pub">JOIN</span>` : `<span class="badge soft">SINGLE</span>`}</td>
        <td class="num">${(x.join_config || []).length}</td>
        <td>
          <button class="btn-ghost btn-sm" data-act="edit" data-id="${x.id}">编辑</button>
          <button class="btn-ghost btn-sm" data-act="sql" data-id="${x.id}">SQL</button>
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
    ],
    value: v,
    onOk: async (o) => {
      if (o.join_type === "SINGLE") o.join_config = [];
      if (id) await put(`/logical-models/${id}`, o);
      else await post("/logical-models", o);
      await refreshAll();
    },
  });
}

// ---------------------------------------------------------------- 血缘
function renderLineage() {
  const code = $("lineage-select").value;
  const el = $("lineage-graph");
  if (!code) { el.innerHTML = `<p class="empty">请选择指标</p>`; return; }
  api(`/lineage/${code}`).then(g => {
    const LEVEL = { table: 0, field: 1, atomic: 2, derived: 3, composite: 4 };
    const nodes = g.nodes.map(n => ({ ...n, level: LEVEL[n.type] }));
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
    const STYLE = {
      table: ["#f1f5f9", "#475569", "物理表"], field: ["#eef2ff", "#6366f1", "物理字段"],
      atomic: ["#eff6ff", "#2563eb", "原子指标"], derived: ["#ecfdf5", "#059669", "派生指标"],
      composite: ["#fffbeb", "#d97706", "复合指标"],
    };
    const svg = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><title>血缘 ${code}</title>`];
    svg.push(`<defs><marker id="lh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`);
    Object.entries(groups).forEach(([lv, group]) => {
      const x = 30 + Number(lv) * (nodeW + colGap);
      svg.push(`<text x="${x}" y="18" font-size="11" fill="#94a3b8">${STYLE[group[0].type][2]}</text>`);
    });
    g.edges.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2;
      const mx = (x1 + x2) / 2;
      svg.push(`<path class="edge-path" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" marker-end="url(#lh)"/>`);
    });
    nodes.forEach(n => {
      const [fill, stroke] = STYLE[n.type];
      const p = pos[n.id];
      svg.push(`<g class="lg-node"><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>` +
        `<text x="${p.x + 12}" y="${p.y + nodeH / 2 - 6}" font-size="12.5" font-weight="500" fill="${stroke}">${esc(n.label)}</text>` +
        `<text x="${p.x + 12}" y="${p.y + nodeH / 2 + 13}" font-size="10.5" fill="${stroke}" opacity="0.7">${esc(n.code)}</text></g>`);
    });
    svg.push("</svg>");
    el.innerHTML = svg.join("");
  }).catch(e => { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; });
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
    else if (btn.dataset.act === "status") {
      const cur = (META.atomic.find(m => m.id === id) || {}).status;
      const next = cur === "PUBLISHED" ? "ARCHIVED" : "PUBLISHED";
      post(`/atomic-metrics/${id}/status`, { status: next }).then(refreshAll).catch(e => toast(e.message, false));
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
  });

  // 血缘
  $("lineage-select").onchange = renderLineage;

  // 各列表搜索（回车触发）
  ["domains", "processes", "atomics", "dims", "derived", "composites"].forEach(tab => {
    const el = $("kw-" + tab);
    el.addEventListener("keydown", e => { if (e.key === "Enter") switchTab(tab); });
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