# 统一指标维度管理平台 Demo

参照阿里云 **DataMetric「规范定义（逻辑层）」** 设计：**元数据驱动 + 查询时动态生成 SQL**。
指标口径全局唯一定义，任何查询均引用同一口径 —— 解决"同一指标在不同部门口径不一致"的核心痛点。
查询可分为**即席动态查询**（不落地）与**下游模型物化**（DWS 汇总表落地）两条路径。

## 架构

```
前端配置/查询  ->  FastAPI 统一指标服务  ->  元数据中心（逻辑层定义）
                              |
                     SQLGenerator 动态拼装 SQL（查询时生成）
                              |___________________
                              |                   |
                     SQLite 物理表（dwd+dim）  物化下游模型（CREATE TABLE dl_xxx）
                     （即席查询 0 落地）        （指标汇总表，可反复重建刷新）
                              |
                              v
                  开放 API（/openapi，AppKey+AppSecret 认证）
                  下游应用按授权调用数据集，供报表看板/直接查询
```

指标体系全链路：`物理表.字段 -> 原子指标 -> 派生指标 -> 复合指标`，血缘关系可双向追溯（影响分析 + 根因分析），并支持**表级血缘**（物理表 → 逻辑模型 → 下游模型 → 物化表）。

## 目录结构

```
metric-demo/
├── backend/
│   ├── models.py         # 元数据模型（22 张表） + SQLite 引擎
│   ├── seed.py           # 电商 Demo 种子数据（30 天物理数据，可重复重建）
│   ├── sql_generator.py  # 核心：元数据驱动的 SQL 动态生成器（含防注入、日期粒度、下游模型定义）
│   └── main.py           # FastAPI 服务（/api/v1 管理端 + /openapi 下游消费端 + 静态前端 + 调度线程）
├── frontend/             # 单页前端（查询/管理/血缘/下游模型/数据集/开放 API，离线可用）
├── tests/                # pytest 单元测试（独立临时库，不污染正式数据）
├── docs/                 # 需求文档 vs DataMetric 对照分析
└── metadata.db           # SQLite 数据库（seed 后生成）
```

## 快速启动

```bash
cd metric-demo

# 1. 初始化种子数据（重建库 + 30 天样例物理数据）
cd backend && ../.venv/bin/python seed.py && cd ..

# 2. 启动服务（默认 127.0.0.1:8000）
cd backend && nohup ../.venv/bin/python main.py > /tmp/metric-demo.log 2>&1 &

# 3. 浏览器访问
#   http://127.0.0.1:8000         管理界面（16 个页签：统一指标查询/主题域/业务过程/原子/维度/派生/复合/逻辑模型/下游模型/任务重导/数据集/开放 API/血缘追溯/审批中心/质量监控/任务运维，右上角通知铃铛）
#   http://127.0.0.1:8000/docs    Swagger API 文档（自动生成）
```

依赖（已装于 `.venv`）：`fastapi uvicorn sqlalchemy openpyxl pytest httpx`

## 测试（三层）

### 第一层：后端 API 逻辑（pytest）

```bash
cd metric-demo
METRIC_DB_PATH=/tmp/test.db .venv/bin/python -m pytest tests/ -q
# 75 个用例；测试使用独立临时库，不污染正式数据
```

覆盖：元数据 CRUD 与删除保护、SQL 生成与防注入、派生/复合指标口径、查询/导出、下游模型物化与重导、血缘追溯、权限审批/版本回滚、质量规则/健康度/告警、调度/任务实例/重试、开放 API 认证与授权。

### 第二层：浏览器 E2E 走查（16 页签逐页验证）

本轮已用浏览器自动化（browser-use）对全部 16 个页签逐一走查：每页检查渲染完整性（关键元素 + 无 `pageErrors`）+ 核心交互冒烟。发现并修复 2 个问题：

1. **批量重导任务的触发方式记录为 `auto`** —— 批量执行计划是手动确认后的用户动作，应记录 `trigger=manual`（`backend/main.py` 两处）
2. **4 处 `window.confirm` 阻塞浏览器自动化** —— 统一替换为页面内 `confirmModal`（可自动化、不阻塞主线程），覆盖：删除确认、批量重导确认、版本回滚确认、失败任务重试确认

### 第三层：人工复跑清单（16 页签验证点）

| # | 页签 | 验证点 |
|---|------|--------|
| 1 | 统一指标查询 | 默认自动查询出结果；多选指标 + 维度 + 日期范围 → 查询 → 汇总卡/表格/条形图/SQL 均更新；导出 Excel、复制 SQL |
| 2 | 主题域 | 列表渲染 + 新建弹窗（编码规范校验） |
| 3 | 业务过程 | 按域筛选 + 新建弹窗 |
| 4 | 原子指标 | 列表 + 新建（业务过程 + 度量方式） |
| 5 | 维度管理 | 列表 + 新建（含属性、主键标记） |
| 6 | 派生指标 | 列表 + 新建（时间周期/统计维度/筛选条件）|
| 7 | 复合指标 | 列表 + 新建（四则运算，零值保护） |
| 8 | 审批中心 | 待办/历史切换 + 提交发布 → 同意/驳回 + 站内通知 |
| 9 | 逻辑模型 | 列表 + 单表/多表 JOIN 配置 |
| 10 | 下游模型 | 列表 + 定义 SQL + 物化一次 |
| 11 | 任务重导 | 选择对象 → 影响分析 → 生成计划 → 确认执行；**重导历史记录自动出现**（触发方式=手动/状态/数据范围/详情可看/失败可重试） |
| 12 | 质量监控 | 健康度三色总览 + 新建规则 + 立即检查 |
| 13 | 任务运维 | 调度列表（启停/立即执行）+ 任务实例筛选/详情 JSON/失败重试 |
| 14 | 数据集 | 物化直读 + 指标实时计算两类数据集预览/授权 |
| 15 | 开放 API | 应用列表 + 重置密钥 + 调用演示（返回行数/耗时）+ 调用用量统计 |
| 16 | 血缘追溯 | 指标血缘（选指标 → 物理表/字段 → 原子 → 派生 → 复合）+ 表血缘（物理表 → 逻辑模型 → 下游模型 → 物化表） |

**复跑方式**：启动服务后打开 `http://127.0.0.1:8000`，按上表逐页签操作；每页确认无控制台 JS 错误、无接口异常提示，核心交互有反馈。

## Demo 场景数据（需求文档第 7 章）

| 类型 | 内容 |
|------|------|
| 业务过程 | 下单 / 支付 / 退款（3 张 dwd 事实表） |
| 原子指标 | 下单次数、下单金额、支付金额、支付笔数、退款金额 |
| 维度 | 城市、商品类目、用户（含维度属性） |
| 派生指标 | 最近7天各城市支付金额/笔数、30天各类目下单金额（含业务限定）、7天各城市退款金额 |
| 复合指标 | 客单价 = 支付金额/支付笔数、退款率 = 退款金额/支付金额（含零值保护） |
| 逻辑模型 | 订单交易宽表（dwd_order_detail JOIN 城市/类目维度） |
| 下游模型 | 城市订单日汇总（order_amount_sum + order_count × dim_city，日粒度），可物化为 `dl_city_order_daily` |
| 下游应用 | 报表看板系统（report_bi）、数据科学平台（data_science）——各持 AppKey/AppSecret |
| 数据集 | 城市订单日报（物化表直读 `dl_city_order_daily`）、城市核心指标（指标实时计算）——授权给下游应用调用 |

## 核心 API（全部 /api/v1 前缀）

### 元数据管理（CRUD，均含删除引用校验→409）

| 资源 | 接口 | 说明 |
|------|------|------|
| 主题域 | `POST/GET/PUT/DELETE /domains`、`GET /domains/{id}` | 分页搜索；删除校验下属业务过程/维度 |
| 业务过程 | `POST/GET/PUT/DELETE /processes`、`GET /processes/{id}` | `?domain_id=` 筛选；详情含下属原子指标 |
| 原子指标 | `POST/GET/PUT/DELETE /atomic-metrics`、`GET /atomic-metrics/{id}` | `?process_id=&status=&keyword=`；`PUT .../{id}/status` 发布/归档 |
| 维度 | `POST/GET/PUT/DELETE /dimensions`、`GET /dimensions/{id}` | 详情含属性列表；删除校验被派生引用 |
| 维度属性 | `POST /dimensions/{id}/attributes`、`PUT/DELETE /dimension-attributes/{attr_id}` | 含主键属性标记 |
| 派生指标 | `POST/GET/PUT/DELETE /derived-metrics`、`GET .../{id}` | 时间周期 + 统计维度 + 筛选条件；`GET .../{id}/sql-preview` |
| 复合指标 | `POST/GET/PUT/DELETE /composite-metrics`、`GET .../{id}` | 四则运算表达式；`GET .../{id}/sql-preview` |
| 逻辑模型 | `POST/GET/PUT/DELETE /logical-models`、`GET .../{id}` | SINGLE/JOIN 类型 + JOIN 配置，返回 generated_sql |
| 下游模型 | `POST/GET/PUT/DELETE /downstream-models`、`GET .../{id}` | 指标汇总表（DWS）定义，生成 definition_sql 入库；已物化则编辑/删除自动清理落地表 |
| 下游应用 | `POST/GET/PUT/DELETE /downstream-apps`、`GET .../{id}` | 开放 API 接入方；创建自动生成 `appkey`+`appsecret`；`POST .../{id}/reset-secret` 重置密钥（AppKey 不变） |
| 数据集 | `POST/GET/PUT/DELETE /datasets`、`GET .../{id}` | 供下游调用的数据资产，双数据源：`downstream_model`（物化表直读）/ `metric_query`（指标实时计算）；`POST .../{id}/grant` 授权应用、`DELETE .../{id}/grant/{app_id}` 撤销 |

### 查询与追溯

| 接口 | 说明 |
|------|------|
| `POST /query` | 统一指标查询：`metric_codes（多选）+ dim_codes + start_date + end_date + granularity` → 自动识别指标类型、动态生成并执行 SQL，返回 summary/columns/rows/sql |
| `GET /sql-preview` | 只生成 SQL 不执行（口径透明可审计；`metric_codes` 逗号分隔 + `granularity`） |
| `GET /query/export` | 查询结果导出 Excel（.xlsx 下载，首列 date_bucket） |
| `POST /downstream-models/{id}/materialize` | 物化：`CREATE TABLE dl_{code} AS <定义 SQL>`；重复执行 = 重建刷新（幂等） |
| `POST /downstream-models/{id}/reimport?start_date=&end_date=` | **数据重导**：上游逻辑模型指标/维度更新上线后，按时间范围重建物化表数据（区间内 DELETE + 按最新定义重算 INSERT，同一事务原子）；默认范围 = 近 3 个月 |
| `GET /reimport/impact?object_type=&object_id=` | **任务重导-影响分析**：按对象（`logical_model`/`atomic_metric`/`derived_metric`/`dimension`）反查受影响下游模型，返回血缘 chain（对象 → 派生中介 → 逻辑模型 → 下游模型） |
| `POST /reimport/plan` | **任务重导-生成执行计划**：`{object_type, object_id, start_date?, end_date?, downstream_ids?}` → 返回每个下游模型预估删除行数（未物化返回 null），供人工确认 |
| `POST /reimport/plan/execute` | **任务重导-确认执行**：`{downstream_ids, start_date?, end_date?}` → 逐模型独立重导（单个失败不阻断其余），返回 ok/skipped/error 汇总 |
| `POST /downstream-models/{id}/preview` | 执行定义 SQL 预览前 N 行（不落地） |
| `GET /downstream-models/{id}/data` | 查询物化表数据（分页，按 date_bucket 排序） |
| `GET /lineage/{code}` | 指标血缘：物理表/字段 → 原子 → 派生 → 复合，支持影响分析与根因追溯 |
| `GET /lineage/tables` | 表级血缘：物理表 → 逻辑模型 → 下游模型 → 物化表（全量） |
| `GET /overview`、`GET /metrics` | 概览统计、元数据轻量查询 |
| `GET /openapi/stats` | 开放 API 用量统计：总调用数/总返回行数 + 按应用、按数据集明细 |
| `GET /openapi/logs` | 调用日志（分页）：应用、数据集、返回行数、耗时、状态、时间 |

### 治理与生命周期

| 资源 | 接口 | 说明 |
|------|------|------|
| 版本 | `GET /metric-versions?entity_type=&entity_id=&page=` | 指标/维度/模型版本历史（快照 JSON + 变更类型 + 变更说明） |
| 回滚 | `POST /metric-versions/{id}/rollback` | 按快照回滚实体字段，并生成一条 rollback 版本记录 |
| 审批 | `POST /approvals` | 提交发布审批（原子/派生/复合指标，`{entity_type, entity_id, comment}`；重复提交 409） |
| 审批 | `GET /approvals?status=&page=` | 审批列表（status 过滤 pending/history）；通过后实体置 `PUBLISHED` 并生成版本 + 站内告警 |
| 审批 | `POST /approvals/{id}/approve`、`POST /approvals/{id}/reject` | 同意（带意见）/ 驳回（带意见，状态不变） |
| 影响评估 | `GET /impact-report?object_type=&object_id=` | **变更影响评估**：任意对象（原子/派生/复合/维度/逻辑模型/下游模型）→ 反查受影响的下游模型 + 派生引用 + 复合引用 + 关联数据集与授权应用，返回统计 + 血缘 chain |
| 标签 | `POST /entity-tags`（`{entity_type, entity_id, tags:[]}` 全量替换）、`DELETE /entity-tags/{tag_id}` | 实体打标；所有列表/详情接口附带 `tags` 字段 |
| 标签 | `GET /tags?keyword=`、`GET /tags/entities?tag=` | 全部标签（含计数）/ 按标签反查实体 |
| 编码规范 | 内置（seed 写入 `meta_code_rule`） | 5 类实体编码统一校验 `^[a-z][a-z0-9_]*$`，创建/更新违反即 400 |

### 数据质量与监控

| 资源 | 接口 | 说明 |
|------|------|------|
| 质量规则 | `POST/GET/PUT/DELETE /quality-rules`、`POST /quality-rules/{id}/toggle` | 下游模型质量规则：`row_count_min`（最小行数）/ `row_count_change`（较上次波动 %）/ `non_null_rate`（非空率）/ `fresh_days`（最大新鲜天数）；级别 info/warning/critical |
| 手动检查 | `POST /quality-rules/{id}/check` | 立即执行规则校验（物化表 COUNT / 非空率 / MAX(date_bucket)）；未物化 → error；fail/error 自动写站内告警 |
| 自动检查 | 物化 / 重导 / 调度执行成功后自动触发 | 对该模型全部启用规则自动校验（trigger=auto），结果写入规则 last_* 字段 |
| 健康度 | `GET /quality/health` | 三色总览：每个下游模型行数/最新分区/新鲜度/规则结果 → `green`/`yellow`/`red`（error 规则或超 7 天未刷新 = red；fail/未物化或超 3 天 = yellow）+ 汇总统计 |
| 告警 | `GET /alerts?unread_only=&page=`、`GET /alerts/unread-count` | 站内通知列表 + 未读数（右上角铃铛角标） |
| 告警 | `POST /alerts/{id}/read`、`POST /alerts/read-all` | 单条已读 / 全部已读 |

### 调度与运维

| 资源 | 接口 | 说明 |
|------|------|------|
| 调度 | `POST/GET/PUT/DELETE /schedules`、`POST /schedules/{id}/toggle` | 下游模型周期调度：`daily`（每天 HH:MM）/ `interval`（每 N 分钟），动作 `materialize`/`reimport`，返回下次执行时间 |
| 立即执行 | `POST /schedules/{id}/run` | 手动触发一次调度动作（不依赖线程时序，前端「立即执行」按钮） |
| 任务实例 | `GET /task-instances?task_type=&status=&page=`、`GET /task-instances/{id}` | 任务实例记录（物化/重导/质量检查，trigger=manual/schedule/auto，含 detail JSON 与 error） |
| 重试 | `POST /task-instances/{id}/retry` | 失败实例一键重放（按实例类型 + 参数重执行） |
| 调度器 | 内置线程（lifespan 启动） | 每 30 秒扫描启用调度到点执行；执行写实例（trigger=schedule）+ 成功自动质量检查 + 失败写告警；零外部依赖 |

## 开放 API（下游消费面，独立挂载 `/openapi`）

下游应用凭 **AppKey + AppSecret** 请求头认证（`hmac.compare_digest` 常数时间比较），仅能调用**已授权**的数据集，每次调用写入日志并可监控。适用于：BI 报表/看板配置数据源、下游系统直接查询。

| 接口 | 说明 |
|------|------|
| `GET /openapi/v1/datasets` | 当前应用有权限的数据集列表 |
| `GET /openapi/v1/datasets/{code}/data?page=&page_size=&start_date=&end_date=` | 数据集数据：物化表直读（分页，按 date_bucket 排序）/ 指标实时计算（支持日期覆盖） |

```bash
# 认证失败：缺头/密钥错 -> 401
curl -s "http://127.0.0.1:8000/openapi/v1/datasets" | head -c 200
# 未授权数据集 -> 403
curl -s -H "X-App-Key: <appkey>" -H "X-App-Secret: <appsecret>" \
  "http://127.0.0.1:8000/openapi/v1/datasets/ds_city_daily/data"
# 正常调用（物化 dl_city_order_daily 后）-> 200，返回 {code,message,data:{columns,rows,total}}
curl -s -H "X-App-Key: <appkey>" -H "X-App-Secret: <appsecret>" \
  "http://127.0.0.1:8000/openapi/v1/datasets/ds_city_daily/data?page_size=10" | head -c 500
```

`appkey`/`appsecret` 在管理端「开放 API」页签创建或重置应用时生成；**AppSecret 仅创建/重置接口返回明文**，列表与详情不再下发。请妥善保管。

## 接口约定

- **Base URL**：`/api/v1`
- **统一响应**：`{"code": 0, "message": "success", "data": ...}`
- **错误码**：`0` 成功 / `400` 参数错误 / `401` 认证失败（开放 API 缺头、密钥错、应用停用） / `403` 未授权（开放 API 数据集无授权） / `404` 不存在 / `409` 冲突（编码重复、删除被引用） / `500` 服务器错误
- **分页**：`page`（从 1 起）、`page_size`（默认 20），返回 `total`
- **指标状态**：`DRAFT / PUBLISHED / ARCHIVED`
- **时间周期**：`1d / 7d / 30d / 90d / ytd / custom`（custom 传 start_date/end_date）
- **日期粒度**：`day`（YYYY-MM-DD）/ `week`（YYYY-Www）/ `month`（YYYY-MM），查询首列为 `date_bucket`
- **筛选运算符**：`= != > >= < <= IN NOT IN BETWEEN LIKE`（值全部参数化绑定）

## 核心设计说明

1. **口径统一**：下游只能通过指标编码查询，SQL 由元数据生成，无旁路实现
2. **动态 SQL**：即席查询由 SQLGenerator 按"原子→派生→复合"逐层解析拼装，多指标按 `date_bucket + 公共维度` LEFT JOIN 对齐，不落地
3. **下游模型物化**：基于逻辑模型宽表生成 DWS 汇总表定义（`CREATE TABLE dl_{code} AS <定义 SQL>`），支持幂等重建刷新；指标过程表不在宽表范围内、复合指标未展开、custom 周期派生指标均拒绝
3b. **数据重导**：上游逻辑模型指标/维度更新上线后，物化表按时间范围重导——区间内先 DELETE 再按最新上游定义重算 INSERT（同一事务，原子），默认近 3 个月（3 个月前当月 1 日 ~ 今天），可传 `start_date`/`end_date` 覆盖；区间外数据不受影响，重复重导幂等
3c. **任务重导模块**：管理端「任务重导」页签支持选择对象（逻辑模型/原子指标/派生指标/维度）→ 自动反查下游任务血缘（无外键，靠编码 JSON 引用递归匹配）→ 生成执行计划（预估各下游模型删除行数）→ 人工确认后批量重导（逐模型独立事务，一个失败不阻断其余）；**指标/维度/模型修改保存后自动触发影响分析**，存在受影响下游模型即弹出执行计划确认框，确认后按最新口径重导
4. **复合指标安全计算**：`CAST(... AS REAL)` 防整数除、`NULLIF(分母, 0)` 零值保护
5. **防注入**：所有表名/字段名/粒度格式走白名单校验（粒度经映射表取值，不直接进 SQL），值全部 `:param` 参数化绑定
6. **全链路血缘**：每层定义记录引用关系（原子记物理字段、派生记原子 ID、复合记派生编码、下游模型记逻辑模型 + 物化表），查询时自动构建血缘图；表级血缘覆盖"物理表 → 逻辑模型 → 下游模型 → 物化表"
7. **删除保护**：任何被引用的实体（主题域、过程、原子、维度、派生）删除均返回 409；下游模型删除/编辑时自动拆除对应物化表
8. **数据集双源**：`downstream_model` 源读物化表 `dl_xxx`（高性能、未物化返回 400 提示）；`metric_query` 源实时动态 SQL 计算（口径与统一查询一致，天然零口径偏差）
9. **开放 API 安全**：AppKey/AppSecret 请求头认证（`hmac.compare_digest` 常数时间比较防时序攻击），应用停用/密钥重置立即生效；数据集级授权（未授权 403）；表名/字段名白名单校验 + 值参数化绑定，注入回归有专门测试
10. **版本与回滚**：原子/派生/复合/维度/逻辑模型的每次更新、状态切换、审批通过、回滚操作前自动存档 JSON 快照（version_no 自增 v1/v2…）；回滚 = 快照写回 + 生成 rollback 版本记录，全程可审计
11. **审批发布流**：原子/派生/复合指标「提交发布」→ 待办审批（同意置 `PUBLISHED` 并写告警 / 驳回状态不变），单级审批；归档仍为直接切换
12. **变更影响评估**：编辑保存后自动反查受影响下游模型（复用无外键编码递归匹配），弹窗展示统计（下游模型/派生引用/复合引用/数据集/授权应用）+ 血缘 chain 图，与「任务重导」影响分析同源
13. **质量规则与健康度**：四类规则（最小行数/行数波动/非空率/新鲜度）手动或自动校验（物化/重导/调度成功后自动触发）；健康度三色（green/yellow/red）一眼总览数据可信度；fail/error 自动生成站内告警
14. **调度零依赖**：内置线程调度器（lifespan 启动，每 30s 扫描），支持 daily/interval 周期调度下游模型物化/重导，全程落任务实例（可筛选/详情/失败重试），不引入 APScheduler/cron 外部依赖
15. **站内告警**：审批通过、质量检查失败、任务执行失败等自动写通知，右上角铃铛实时未读角标，可单条/全部已读

## 更多文档

- [需求文档 vs DataMetric 功能对照分析](docs/DataMetric对照分析.md) —— 功能/数据模型/API 逐项对照 + 差距清单（DataMetric 提供而需求未覆盖：审批流、指标版本、质量监控、调度、权限等；其中审批流/版本/质量/调度已在本 Demo 以轻量方案落地，详见上文三大模块 API）