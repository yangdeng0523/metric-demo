# 统一指标维度管理平台 Demo

参照阿里云 **Dataphin「规范定义（逻辑层）」** 设计：**元数据驱动 + 查询时动态生成 SQL**。
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
```

指标体系全链路：`物理表.字段 -> 原子指标 -> 派生指标 -> 复合指标`，血缘关系可双向追溯（影响分析 + 根因分析），并支持**表级血缘**（物理表 → 逻辑模型 → 下游模型 → 物化表）。

## 目录结构

```
metric-demo/
├── backend/
│   ├── models.py         # 元数据模型（10 张表） + SQLite 引擎
│   ├── seed.py           # 电商 Demo 种子数据（30 天物理数据，可重复重建）
│   ├── sql_generator.py  # 核心：元数据驱动的 SQL 动态生成器（含防注入、日期粒度、下游模型定义）
│   └── main.py           # FastAPI 服务（/api/v1 + 静态前端）
├── frontend/             # 单页前端（查询/管理/血缘/下游模型/导出，离线可用）
├── tests/                # pytest 单元测试（35 个用例）
├── docs/                 # 需求文档 vs Dataphin 对照分析
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
#   http://127.0.0.1:8000         管理界面（10 个页签：查询/主题域/业务过程/原子/维度/派生/复合/逻辑模型/下游模型/血缘）
#   http://127.0.0.1:8000/docs    Swagger API 文档（自动生成）
```

依赖（已装于 `.venv`）：`fastapi uvicorn sqlalchemy openpyxl pytest httpx`

## 运行测试

```bash
cd metric-demo
METRIC_DB_PATH=/tmp/test.db .venv/bin/python -m pytest tests/ -q   # 35 passed
# 测试使用独立临时库，不污染正式数据
```

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

### 查询与追溯

| 接口 | 说明 |
|------|------|
| `POST /query` | 统一指标查询：`metric_codes（多选）+ dim_codes + start_date + end_date + granularity` → 自动识别指标类型、动态生成并执行 SQL，返回 summary/columns/rows/sql |
| `GET /sql-preview` | 只生成 SQL 不执行（口径透明可审计；`metric_codes` 逗号分隔 + `granularity`） |
| `GET /query/export` | 查询结果导出 Excel（.xlsx 下载，首列 date_bucket） |
| `POST /downstream-models/{id}/materialize` | 物化：`CREATE TABLE dl_{code} AS <定义 SQL>`；重复执行 = 重建刷新（幂等） |
| `POST /downstream-models/{id}/preview` | 执行定义 SQL 预览前 N 行（不落地） |
| `GET /downstream-models/{id}/data` | 查询物化表数据（分页，按 date_bucket 排序） |
| `GET /lineage/{code}` | 指标血缘：物理表/字段 → 原子 → 派生 → 复合，支持影响分析与根因追溯 |
| `GET /lineage/tables` | 表级血缘：物理表 → 逻辑模型 → 下游模型 → 物化表（全量） |
| `GET /overview`、`GET /metrics` | 概览统计、元数据轻量查询 |

## 接口约定

- **Base URL**：`/api/v1`
- **统一响应**：`{"code": 0, "message": "success", "data": ...}`
- **错误码**：`0` 成功 / `400` 参数错误 / `404` 不存在 / `409` 冲突（编码重复、删除被引用） / `500` 服务器错误
- **分页**：`page`（从 1 起）、`page_size`（默认 20），返回 `total`
- **指标状态**：`DRAFT / PUBLISHED / ARCHIVED`
- **时间周期**：`1d / 7d / 30d / 90d / ytd / custom`（custom 传 start_date/end_date）
- **日期粒度**：`day`（YYYY-MM-DD）/ `week`（YYYY-Www）/ `month`（YYYY-MM），查询首列为 `date_bucket`
- **筛选运算符**：`= != > >= < <= IN NOT IN BETWEEN LIKE`（值全部参数化绑定）

## 核心设计说明

1. **口径统一**：下游只能通过指标编码查询，SQL 由元数据生成，无旁路实现
2. **动态 SQL**：即席查询由 SQLGenerator 按"原子→派生→复合"逐层解析拼装，多指标按 `date_bucket + 公共维度` LEFT JOIN 对齐，不落地
3. **下游模型物化**：基于逻辑模型宽表生成 DWS 汇总表定义（`CREATE TABLE dl_{code} AS <定义 SQL>`），支持幂等重建刷新；指标过程表不在宽表范围内、复合指标未展开、custom 周期派生指标均拒绝
4. **复合指标安全计算**：`CAST(... AS REAL)` 防整数除、`NULLIF(分母, 0)` 零值保护
5. **防注入**：所有表名/字段名/粒度格式走白名单校验（粒度经映射表取值，不直接进 SQL），值全部 `:param` 参数化绑定
6. **全链路血缘**：每层定义记录引用关系（原子记物理字段、派生记原子 ID、复合记派生编码、下游模型记逻辑模型 + 物化表），查询时自动构建血缘图；表级血缘覆盖"物理表 → 逻辑模型 → 下游模型 → 物化表"
7. **删除保护**：任何被引用的实体（主题域、过程、原子、维度、派生）删除均返回 409；下游模型删除/编辑时自动拆除对应物化表

## 更多文档

- [需求文档 vs Dataphin 功能对照分析](docs/Dataphin对照分析.md) —— 功能/数据模型/API 逐项对照 + 差距清单（Dataphin 提供而需求未覆盖：审批流、指标版本、质量监控、调度、权限等）