# 需求文档 vs 阿里云 Dataphin 功能对照分析

> 分析对象：《统一指标维度管理平台 Demo 需求文档》
> 对比基准：阿里云 Dataphin「规范定义 / 数仓规划」逻辑层能力
> 结论先行：**Demo 需求完整覆盖了 Dataphin 逻辑层的核心语义（主题域→业务过程→原子指标→派生指标→复合指标 + 维度 + 逻辑模型），实现方式与 Dataphin 同构；差异集中在 Dataphin 的「生产配套」能力（审批发布、版本、质量、调度）和「修饰词」是否独立成实体这两处。**

---

## 1. 需求功能清单 vs Dataphin 能力对照

| # | 需求功能（优先级） | Dataphin 对应能力 | 本 Demo 实现状态 | 差异 / 等价性说明 |
|---|---|---|---|---|
| 1 | 主题域管理（P0） | 业务板块 → 主题域（数据规划） | ✅ 完整 CRUD + 分页搜索 + 删除引用校验 | Dataphin 是「业务板块 > 主题域」两级；需求文档只取「主题域」一级，语义对齐 |
| 2 | 业务过程管理（P0） | 业务过程（事件型过程，关联事实表） | ✅ 完整 CRUD + 按主题域筛选 + 详情含原子指标列表 + 删除校验 | 与 Dataphin「业务过程」完全对应，含 physical_table 关联 |
| 3 | 原子指标管理（P0） | 原子指标（业务过程 + 聚合逻辑 + 物理字段） | ✅ CRUD + 状态流转(DRAFT/PUBLISHED/ARCHIVED) + 引用此指标的派生指标列表 + 删除校验(409) | 聚合函数 SUM/COUNT/AVG/MAX/MIN/COUNT_DISTINCT 与 Dataphin 一致 |
| 4 | 维度管理（P0） | 维度 + 维度属性（含主键属性） | ✅ 维度 CRUD + 属性增删改 + 删除校验 | `is_primary_key` 对齐 Dataphin 维度主键属性 |
| 5 | 派生规则引擎（P0） | 派生指标 = 原子指标 + 修饰词 | ✅ 派生指标 CRUD + 时间周期 + 统计维度 + 筛选条件(10 运算符) + SQL 预览 + 删除校验 | **见 §3「修饰词」关键差异** |
| 6 | 统一指标查询（P1） | 指标分析 / 即席查询 | ✅ POST 查询 + 自动 SQL 生成 + 按维度分组 | 需求文档以 `metric_id + metric_type + dimensions + time_range` 传参；实现按**全局唯一编码**（`metric_code + dim_codes + start_date/end_date`）请求，并自动解析指标类型（原子/派生/复合）——输入等价、口径一致，交互更轻量 |
| 7 | 逻辑模型映射（P1） | 逻辑表（维度/事实逻辑表）| ✅ 逻辑模型 CRUD + SINGLE/JOIN 类型 + JOIN 配置 + generated_sql | 对应 Dataphin 事实逻辑表（明细/汇总）+ JOIN 关联 |
| 8 | 血缘追溯（P2） | 血缘分析（影响分析 + 根因分析） | ✅ 全链路血缘：物理字段→原子→派生→复合 + 双向追溯 | 节点类型/边方向与 Dataphin 血缘一致，支持从任意节点展开 |
| 9 | 可视化看板（P2） | 指标结果图表展示 | ✅ 前端 Chart 渲染（水平条形图） | Dataphin 是报表/Analytics 层，Demo 用前端原生图表等价覆盖 |
| 10 | Excel 导出（P1 查询配套） | 查询结果导出 | ✅ `/query/export` 导出 xlsx | —— |
| 11 | SQL 预览（查询配套） | 指标 SQL 解析/查看 | ✅ 派生/复合 `{id}/sql` + 查询 `preview-sql` | 参数化绑定（SQLite `:param`）等价于示例的 MySQL `DATE_SUB` |

---

## 2. 数据模型对照（9 张表）

| 需求文档表 | Dataphin 对应元数据 | 说明 |
|---|---|---|
| subject_domain | 业务板块 → 主题域 | Dataphin 两级（业务板块>主题域），需求取一级，编码/名称/排序一致 |
| business_process | 业务过程 | 相同概念，关联物理事实表 |
| atomic_metric | 原子指标 | 相同概念 + `status`（Dataphin 用「发布状态」） |
| dimension / dimension_attribute | 维度 / 维度属性 | 相同概念 |
| derived_metric | 派生指标（修饰词组合） | Dataphin 修饰词分四类：时间修饰词、其他修饰词（业务限定）、维度修饰词（统计粒度）、枚举修饰词；需求把「时间周期 + 统计维度 + 筛选条件」内嵌为三个字段 |
| composite_metric | 复合指标 | 表达式 + 引用指标列表，完全对齐 |
| logical_model | 逻辑表 | 需求演化为「物理表映射 + 可配置 JOIN」 |

> 一致性：9/9 张表在 Dataphin 中都有对应物，无凭空设计。

---

## 3. API 契约对照

| 需求文档约定 | Demo 实现 | 状态 |
|---|---|---|
| Base URL `/api/v1` | ✅ 全部接口带前缀 | ✅ |
| 统一响应 `{code, message, data}` | ✅ 全局响应包装 | ✅ |
| 分页 `page` / `page_size`（默认 20） | ✅ 列表接口分页 | ✅ |
| 错误码 0 / 400 / 404 / 409 / 500 | ✅ 409=唯一冲突/引用冲突，404=不存在 | ✅ |
| 附录 A 时间周期 `1d/7d/30d/90d/ytd/custom` | ✅ 全部实现 | ✅ |
| 附录 B 运算符 `= != > >= < <= IN NOT IN BETWEEN LIKE` | ✅ 全部实现 | ✅ |
| 状态 `DRAFT / PUBLISHED / ARCHIVED` | ✅ 三种状态 + 状态变更接口 | ✅ |

---

## 4. API 路径一致性核验

```
✅ POST   /api/v1/domains                     GET    /api/v1/domains/{id}
✅ POST   /api/v1/processes                   GET    /api/v1/processes?domain_id=
✅ POST   /api/v1/atomic-metrics              GET    /api/v1/atomic-metrics?process_id=&status=&keyword=
✅ PUT    /api/v1/atomic-metrics/{id}/status  发布/归档
✅ POST   /api/v1/dimensions/{id}/attributes  PUT/DELETE .../attributes/{attr_id}
✅ POST   /api/v1/derived-metrics             GET    /api/v1/derived-metrics/{id}/sql
✅ POST   /api/v1/composite-metrics           GET    /api/v1/composite-metrics/{id}/sql
⚠️ 查询三接口：需求 6.8 为 POST /query/execute + GET /query/preview-sql + POST /query/export
     实现为 POST /query + GET /sql-preview + GET /query/export（导出用 GET 直链方便浏览器下载）
     —— 功能全集（执行 / SQL 预览 / 导出）逐项对齐，路径与传参方式做了简化
```
管理类接口路径、参数、分页均按需求文档逐条实现；查询类接口以「编码传参 + 类型自解析」等价实现（见上表第 6 行），另补充 `/overview` 概览、`/logical-models` 系列、`/metrics` 元数据查询等。

---

## 5. 语义一致性：派生规则引擎

需求文档定义：**派生指标 = 原子指标 + 时间周期 + 统计粒度（维度）+ 业务限定（筛选条件）** —— 这正是 Dataphin 派生指标的完整定义。

Demo SQL 生成逻辑（以「最近7天各城市支付金额」为例）：
- 解析原子指标 → 取物理表 `dwd_pay_detail` + 字段 `pay_amount` + 聚合 `SUM`
- 时间周期 `7d` → `WHERE fact.pay_time >= :start`（绑定参数，等价需求示例的 `DATE_SUB(CURDATE(), INTERVAL 7 DAY)`）
- 统计粒度 `dim_city` → `JOIN dim_city ON fact.city_id = dim_city.city_id` + `GROUP BY dim_city.city_name`
- 筛选条件 → `WHERE` 追加（支持附录 B 全部 10 种运算符）
- 复合指标 → 子查询 CTE + `JOIN` 按维度对齐 + `CAST(... AS REAL)` 防整数除 + `NULLIF(分母,0)` 零值保护

---

## 7. 差距清单（Dataphin 提供、需求未覆盖 → Demo 不做）

| 差距项 | Dataphin 能力 | 是否影响需求达标 |
|---|---|---|
| 修饰词独立管理 | 时间周期/统计粒度/业务限定作为独立字典管理，可复用 | ⚠ 需求选择内嵌（派生指标 3 字段），精简了管理面，核心计算语义未变 |
| 指标版本管理 | 每次发布生成版本快照 | 需求列为 P3（增强体验），Demo 未实现版本快照，但状态机保留 |
| 审批发布流 | 提交→审核→发布（工作流） | 需求仅要求状态流转，无审批人角色，Demo 直接切换状态 |
| 数据质量监控 / 告警 | 指标健康度、质量规则 | 超出需求范围（Demo 场景） |
| 调度与运维 | 周期调度、实例监控 | 超出 Demo 范围 |
| 数据权限/租户 | RBAC、行列级权限、数据服务发布 | Demo 明确「无需鉴权，预留鉴权接口」（非功能需求 9 安全性） |
| 数据资产目录（专辑/文件夹） | 指标分类树、专辑收藏 | 用主题域二级结构替代（对应 Dataphin 主题域规划） |
| 智能（AI 建模/问答） | ChatBI、自动建模 | 超出 Demo 范围 |

## 8. 结论

1. **语义层面**：需求文档复现了 Dataphin 逻辑层的核心——"口径统一、复用高效、变更可控、血缘透明"四大核心价值全部对应落地；「派生指标 = 原子指标 + 修饰词」公式与 Dataphin 完全一致。
2. **实现层面**：Demo 与 Dataphin 的差别主要是**生产化能力**（审批、版本、质量、调度、权限），而非语义缺陷；作为轻量级 Demo（P0/P1/P2 全实现）是恰当的裁剪。
3. **可扩展性**：Schema 中 `derived_metric` 的三个修饰字段若后续要升级为 Dataphin 修饰词体系，只需拆成独立的修饰词表并加外键，无需改动 SQL 生成引擎核心——演进路径平滑。