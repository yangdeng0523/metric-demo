"""核心逻辑单元测试（需求文档第 9 章：SQL 生成、指标派生需有单元测试）

覆盖：
  1. 派生规则引擎：时间周期解析、维度 JOIN、业务限定（筛选条件）-> SQL 生成
  2. 复合指标：表达式替换、防除零、子查询 JOIN
  3. 统一指标查询：多指标/多维度联合查询、日/周/月日期粒度、口径一致
  4. 下游模型：定义 SQL 生成、物化（幂等刷新）、表血缘
  5. 安全：标识符白名单防注入
  6. API：统一响应结构、引用校验（409）、编码冲突（409）、参数校验（400）
  7. 血缘：指标全链路 + 表级血缘（物理表 -> 逻辑模型 -> 下游模型 -> 物化表）
"""
import datetime as dt
import re

import pytest

from sql_generator import SQLGenerator, MetricNotFoundError

gen = SQLGenerator()


# ===========================================================================
# 派生规则引擎：原子指标 + 修饰词 -> SQL
# ===========================================================================

def test_derived_sql_time_period(api):
    """最近7天：SQL 应含维度 JOIN、时间条件（动态参数）"""
    mtype, sql, params = gen.generate_sql_only("pay_amount_7d_city")
    assert mtype == "derived"
    assert "SUM(t.pay_amount)" in sql
    assert "FROM dwd_pay_detail t" in sql
    assert "LEFT JOIN dim_city" in sql
    assert "pay_date >= :_start" in sql and "pay_date <= :_end" in sql


def test_period_resolution():
    today = dt.date.today()
    # 7d
    start, end = gen.resolve_period("7d")
    assert end == today and (today - start).days == 7
    # ytd
    start, end = gen.resolve_period("ytd")
    assert start == dt.date(today.year, 1, 1) and end == today
    # custom 必须传 start_date
    with pytest.raises(ValueError):
        gen.resolve_period("custom")
    # 非法周期
    with pytest.raises(ValueError):
        gen.resolve_period("999d")


def test_derived_filter_business_limit(api):
    """业务限定：order_status IN ('PAID','SHIPPED') 应生成 IN 条件（值走绑定参数，防注入）"""
    res = api.get("/api/v1/derived-metrics/3/sql-preview")
    d = res.json()["data"]
    assert "order_status IN" in d["sql"]
    assert "PAID" in str(d["params"].values()) and "SHIPPED" in str(d["params"].values())

    mtype, sql, params = gen.generate_sql_only(
        "order_amount_30d_cat",
        None,
        (dt.date.today() - dt.timedelta(days=30)).isoformat(),
        dt.date.today().isoformat())
    assert "order_status IN" in sql
    assert "PAID" in params.values() and "SHIPPED" in params.values()


def test_composite_sql_expression(api):
    """客单价 = 支付金额/支付笔数：应生成子查询 JOIN + NULLIF 防除零"""
    d = api.get("/api/v1/composite-metrics/1").json()["data"]
    sql = d["generated_sql"]
    assert "NULLIF" in sql
    assert "CAST(" in sql
    # 两个引用派生指标均生成子查询
    for ref in ("pay_amount_7d_city", "pay_count_7d_city"):
        assert ref in d["ref_codes"]


def test_composite_execute_grouped(api):
    r = api.post("/api/v1/query", json={"metric_code": "avg_order_value",
                                        "dim_codes": ["dim_city"]})
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["summary"]["metric_types"] == ["composite"]
    cols = d["columns"]
    # 新契约：首列日期桶，指标值列在维度列之后
    assert cols[0] == "date_bucket" and "dim_city" in cols
    vi = cols.index("avg_order_value")
    assert len(d["rows"]) > 0
    # 客单价为正且有限（行结构 [date_bucket, 维度..., 指标...]，值列按 columns 定位）
    for row in d["rows"]:
        assert row[vi] is not None and row[vi] > 0


def test_refund_rate_sanity(api):
    """退款率 = 退款金额/支付金额 ∈ [0, 1]，口径一致"""
    r = api.post("/api/v1/query", json={"metric_code": "refund_rate",
                                        "dim_codes": ["dim_city"]})
    d = r.json()["data"]
    vi = d["columns"].index("refund_rate")
    for row in d["rows"]:
        assert row[vi] is not None and 0 <= row[vi] <= 1, f"退款率异常: {row}"


# ===========================================================================
# 统一指标查询
# ===========================================================================

def test_query_atomic_with_dims(api):
    """原子指标 + 维度 + 时间范围 -> 返回一致口径结果（含日期桶首列）"""
    r = api.post("/api/v1/query", json={
        "metric_code": "pay_amount_sum", "dim_codes": ["dim_city"],
        "start_date": "2026-08-01", "end_date": "2026-08-19"})
    d = r.json()["data"]
    assert r.status_code == 200
    assert d["summary"]["row_count"] > 0
    assert d["columns"][0] == "date_bucket"
    assert "dim_city" in d["columns"] and "pay_amount_sum" in d["columns"]
    # 值列位于日期桶与维度列之后
    assert d["columns"].index("pay_amount_sum") == 2
    assert d["summary"]["granularity"] == "day"
    assert d["summary"]["metric_names"] == ["支付金额"]
    for row in d["rows"]:
        assert re.match(r"^\d{4}-\d{2}-\d{2}$", row[0])  # 日桶格式 YYYY-MM-DD


def test_query_metric_not_found(api):
    r = api.post("/api/v1/query", json={"metric_code": "not_exist"})
    assert r.status_code == 404
    assert r.json()["code"] == 404


def test_query_invalid_dim(api):
    """非法维度编码 -> 400，不执行 SQL"""
    r = api.post("/api/v1/query", json={"metric_code": "pay_amount_sum",
                                        "dim_codes": ["evil_dim"]})
    assert r.status_code == 400


def test_sql_preview_no_execution(api):
    r = api.get("/api/v1/sql-preview",
                params={"metric_codes": "pay_amount_7d_city,order_amount_sum",
                        "granularity": "week"})
    d = r.json()["data"]
    assert "SELECT" in d["sql"] and d["params"]
    assert d["metric_codes"] == ["pay_amount_7d_city", "order_amount_sum"]
    assert d["granularity"] == "week"
    # 周粒度桶格式写入 SQL（strftime 白名单映射）
    assert "strftime('%Y-W%W'" in d["sql"]


# ===========================================================================
# SQL 注入防护
# ===========================================================================

def test_injection_metric_code(api):
    """注入尝试：不合法编码被拒绝（400/404），且数据库不受影响"""
    r = api.post("/api/v1/query", json={"metric_code": "x'; DROP TABLE t;--"})
    assert r.status_code in (400, 404)
    # 验证注入未生效：平台元数据完好，查询仍可用
    r = api.get("/api/v1/metrics")
    assert r.status_code == 200 and len(r.json()["data"]["atomic"]) == 5
    r = api.post("/api/v1/query", json={"metric_code": "pay_amount_7d_city",
                                        "dim_codes": ["dim_city"]})
    assert r.status_code == 200


def test_injection_dim_code(api):
    r = api.post("/api/v1/query", json={"metric_code": "pay_amount_sum",
                                        "dim_codes": ["dim_city; DROP"]})
    assert r.status_code == 400


# ===========================================================================
# 接口契约：统一响应 / 引用校验 / 编码冲突 / 参数校验
# ===========================================================================

def test_unified_response_shape(api):
    r = api.get("/api/v1/domains")
    body = r.json()
    assert set(body.keys()) == {"code", "message", "data"}
    assert body["code"] == 0 and body["data"]["total"] == 1


def test_duplicate_code_409(api):
    r = api.post("/api/v1/domains", json={"code": "trade", "name": "重复"})
    assert r.status_code == 409
    assert "编码已存在" in r.json()["message"]


def test_delete_referenced_atomic_blocked(api):
    """pay_amount_sum 被派生指标引用 -> 409"""
    r = api.delete("/api/v1/atomic-metrics/3")
    assert r.status_code == 409


def test_delete_referenced_dim_blocked(api):
    r = api.delete("/api/v1/dimensions/1")
    assert r.status_code == 409
    assert "禁止删除" in r.json()["message"]


def test_create_derived_validation(api):
    # 非法时间周期
    r = api.post("/api/v1/derived-metrics", json={
        "code": "bad_period", "name": "错误周期", "atomic_code": "pay_amount_sum",
        "time_period": "999d"})
    assert r.status_code == 400
    # 不合法的筛选操作符
    r = api.post("/api/v1/derived-metrics", json={
        "code": "bad_filter", "name": "错误限定", "atomic_code": "pay_amount_sum",
        "time_period": "7d", "filters": [{"field": "x", "op": "HACK", "value": 1}]})
    assert r.status_code == 400


def test_status_change_flow(api):
    """原子指标状态：DRAFT -> PUBLISHED -> ARCHIVED"""
    r = api.post("/api/v1/atomic-metrics", json={
        "code": "tmp_status", "name": "临时", "process_id": 1,
        "agg_function": "COUNT", "physical_field": "order_id", "status": "DRAFT"})
    mid = r.json()["data"]["id"]
    r = api.post(f"/api/v1/atomic-metrics/{mid}/status",
                 json={"status": "ARCHIVED"})
    assert r.json()["data"]["status"] == "ARCHIVED"
    r = api.post(f"/api/v1/atomic-metrics/{mid}/status", json={"status": "BAD"})
    assert r.status_code == 400
    api.delete(f"/api/v1/atomic-metrics/{mid}")  # 清理


def test_derived_full_crud(api):
    """派生规则引擎端到端：界面配置 -> 元数据 -> 即刻查询"""
    today = dt.date.today()
    r = api.post("/api/v1/derived-metrics", json={
        "code": "pay_amount_30d_region", "name": "最近30天各大区支付金额",
        "atomic_code": "pay_amount_sum", "time_period": "30d",
        "dim_codes": ["dim_city"],
        "filters": [{"field": "pay_channel", "op": "IN", "value": ["WECHAT", "ALIPAY"]}]})
    assert r.status_code == 200, r.text
    mid = r.json()["data"]["id"]

    # SQL 预览：应含筛选条件
    r = api.get(f"/api/v1/derived-metrics/{mid}/sql-preview")
    assert "pay_channel" in r.json()["data"]["sql"]

    # 查询可用
    r = api.post("/api/v1/query", json={"metric_code": "pay_amount_30d_region",
                                        "dim_codes": ["dim_city"]})
    assert r.status_code == 200

    # 更新周期
    r = api.put(f"/api/v1/derived-metrics/{mid}", json={
        "code": "pay_amount_30d_region", "name": "最近30天各大区支付金额",
        "atomic_code": "pay_amount_sum", "time_period": "7d",
        "dim_codes": ["dim_city"], "filters": []})
    assert r.status_code == 200

    # 删除（未被复合引用）
    r = api.delete(f"/api/v1/derived-metrics/{mid}")
    assert r.status_code == 200
    r = api.get(f"/api/v1/derived-metrics/{mid}")
    assert r.status_code == 404


def test_logic_model_crud_and_sql(api):
    """逻辑模型：定义 JOIN 宽表 -> 生成 SELECT 预览"""
    r = api.post("/api/v1/logical-models", json={
        "code": "test_wide", "name": "测试宽表", "domain_id": 1,
        "physical_table": "dwd_order_detail", "join_type": "JOIN",
        "join_config": [{"table": "dim_city", "alias": "d0",
                         "on": "t.city_id = d0.city_id"}]})
    assert r.status_code == 200
    r = api.get("/api/v1/logical-models")
    model = [m for m in r.json()["data"] if m["code"] == "test_wide"][0]
    assert "LEFT JOIN dim_city d0" in model["generated_sql"]
    assert model["join_type"] == "JOIN"
    api.delete(f"/api/v1/logical-models/{model['id']}")


def test_dimension_attribute_crud(api):
    r = api.post("/api/v1/dimensions/1/attributes",
                 json={"code": "test_attr", "name": "测试属性",
                       "physical_field": "city_name"})
    assert r.status_code == 200
    attr_id = r.json()["data"]["id"]
    r = api.get("/api/v1/dimensions/1")
    assert any(a["id"] == attr_id for a in r.json()["data"]["attributes"])
    r = api.delete(f"/api/v1/dimension-attributes/{attr_id}")
    assert r.status_code == 200


# ===========================================================================
# Excel 导出
# ===========================================================================

def test_export_excel(api):
    r = api.get("/api/v1/query/export", params={
        "metric_codes": "pay_amount_7d_city,order_count", "dim_codes": "dim_city"})
    assert r.status_code == 200
    assert "spreadsheetml" in r.headers["content-type"]
    assert r.content[:2] == b"PK"  # zip 魔数
    from openpyxl import load_workbook
    wb = load_workbook(io_bytes(r.content))
    ws = wb.active
    # 表头 = 新查询契约：date_bucket + 维度 + 指标列
    assert [ws.cell(1, c).value for c in (1, 2, 3, 4)] == [
        "date_bucket", "dim_city", "pay_amount_7d_city", "order_count"]
    assert ws.max_row >= 2  # 表头 + 至少一行数据
    # 与查询接口行数一致（口径一致）
    q = api.post("/api/v1/query", json={
        "metric_codes": ["pay_amount_7d_city", "order_count"],
        "dim_codes": ["dim_city"]}).json()["data"]
    assert ws.max_row == len(q["rows"]) + 1


def io_bytes(b):
    import io
    return io.BytesIO(b)


# ===================================================================
# 血缘
# ===================================================================

def test_lineage_full_chain(api):
    r = api.get("/api/v1/lineage/avg_order_value")
    d = r.json()["data"]
    types = {n["type"] for n in d["nodes"]}
    # 契约：物理表=table / 物理字段=field / 指标=atomic|derived|composite
    assert {"composite", "derived", "atomic", "table", "field"} <= types
    # 物理层 -> 原子 -> 派生 -> 复合 的边
    assert any(e["to"].startswith("composite:") for e in d["edges"])
    assert any(e["from"].startswith("field:") for e in d["edges"])


def test_lineage_unknown_404(api):
    r = api.get("/api/v1/lineage/nope")
    assert r.status_code == 404


# ===================================================================
# 多指标联合查询 + 日期粒度（日/周/月）
# ===================================================================

def test_multi_metric_alignment(api):
    """多指标 + 多维度联合查询：按 date_bucket + 公共维度 LEFT JOIN 对齐"""
    r = api.post("/api/v1/query", json={
        "metric_codes": ["order_amount_sum", "order_count"],
        "dim_codes": ["dim_city", "dim_category"],
        "start_date": "2026-08-01", "end_date": "2026-08-19",
        "granularity": "day"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["columns"] == ["date_bucket", "dim_city", "dim_category",
                            "order_amount_sum", "order_count"]
    assert d["summary"]["metric_names"] == ["下单金额", "下单次数"]
    assert d["summary"]["metric_types"] == ["atomic", "atomic"]
    assert d["summary"]["granularity"] == "day"
    assert len(d["rows"]) > 0
    for row in d["rows"]:
        assert len(row) == 5
        assert re.match(r"^\d{4}-\d{2}-\d{2}$", row[0])
        assert row[3] is not None and row[4] is not None  # 两指标均对齐非空


def test_multi_metric_mixed_types(api):
    """原子 + 派生 + 复合混合查询：值列按指标编码定位，LEFT JOIN 可产生空值"""
    r = api.post("/api/v1/query", json={
        "metric_codes": ["order_amount_sum", "pay_amount_7d_city"],
        "dim_codes": ["dim_city"], "granularity": "day"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert set(d["summary"]["metric_types"]) == {"atomic", "derived"}
    assert "order_amount_sum" in d["columns"] and "pay_amount_7d_city" in d["columns"]


def test_granularity_week_month(api):
    """日期粒度桶格式：周 YYYY-Www / 月 YYYY-MM"""
    cases = (("week", r"^\d{4}-W\d{2}$"), ("month", r"^\d{4}-\d{2}$"))
    for g, pat in cases:
        r = api.post("/api/v1/query", json={
            "metric_codes": ["order_amount_sum"], "dim_codes": ["dim_city"],
            "granularity": g, "start_date": "2026-08-01", "end_date": "2026-08-19"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["summary"]["granularity"] == g
        assert d["columns"][0] == "date_bucket"
        assert len(d["rows"]) > 0
        for row in d["rows"]:
            assert re.match(pat, row[0]), f"{g} 桶格式异常: {row[0]}"


def test_invalid_granularity_400(api):
    r = api.post("/api/v1/query", json={"metric_codes": ["order_amount_sum"],
                                        "granularity": "hour"})
    assert r.status_code == 400
    assert "粒度" in r.json()["message"]
    # sql-preview / export 同样拒绝
    r = api.get("/api/v1/sql-preview", params={"metric_codes": "order_amount_sum",
                                               "granularity": "hour"})
    assert r.status_code == 400


def test_dim_incompatible_metric_400(api):
    """维度关联字段不在指标物理表中 -> 400（防 500 崩溃）"""
    r = api.post("/api/v1/query", json={
        "metric_codes": ["refund_amount_sum"], "dim_codes": ["dim_user"]})
    assert r.status_code == 400
    assert "不支持维度" in r.json()["message"]
    # 元数据完好
    assert api.get("/api/v1/metrics").status_code == 200


def test_injection_metric_codes(api):
    """多指标参数注入：非法编码被拒，数据库不受影响"""
    r = api.post("/api/v1/query", json={
        "metric_codes": ["pay_amount_sum; DROP TABLE meta_atomic_metric;--"]})
    assert r.status_code in (400, 404)
    r = api.get("/api/v1/metrics")
    assert r.status_code == 200 and len(r.json()["data"]["atomic"]) == 5


# ===================================================================
# 下游模型：定义 SQL / 物化（幂等）/ 表血缘
# ===================================================================

def _trade_wide_lm(api):
    lms = api.get("/api/v1/logical-models").json()["data"]
    return [m for m in lms if m["code"] == "trade_wide_order"][0]


def test_downstream_crud_and_materialize(api):
    """下游模型：创建（定义 SQL 入库）-> 物化 -> 幂等刷新 -> 编辑重置 -> 删除"""
    lm = _trade_wide_lm(api)
    r = api.post("/api/v1/downstream-models", json={
        "code": "city_pay_daily_test", "name": "城市订单日汇总(测试)",
        "source_model_id": lm["id"], "granularity": "day",
        "metrics": [{"metric_code": "order_amount_sum", "dim_codes": ["dim_city"]},
                    {"metric_code": "order_count", "dim_codes": ["dim_city"]}]})
    assert r.status_code == 200, r.text
    mid = r.json()["data"]["id"]
    sql0 = r.json()["data"]["definition_sql"]
    assert len(sql0) > 0 and "date_bucket" in sql0 and "CREATE" not in sql0

    # 详情：定义 SQL 持久化，列表可见
    d = api.get(f"/api/v1/downstream-models/{mid}").json()["data"]
    assert d["definition_sql"] == sql0
    assert d["materialized"] is False
    items = api.get("/api/v1/downstream-models").json()["data"]["items"]
    assert any(x["id"] == mid and x["source_model_name"] == "订单交易宽表"
               for x in items)

    # 物化：CREATE TABLE dl_{code} AS <sql>；再次物化 = 重建刷新（幂等）
    r = api.post(f"/api/v1/downstream-models/{mid}/materialize")
    assert r.status_code == 200, r.text
    tbl, n1 = r.json()["data"]["physical_table"], r.json()["data"]["row_count"]
    assert tbl == "dl_city_pay_daily_test" and n1 > 0
    r2 = api.post(f"/api/v1/downstream-models/{mid}/materialize")
    assert r2.status_code == 200 and r2.json()["data"]["row_count"] == n1

    # 物化状态 + 物化表数据可查
    m = [x for x in api.get("/api/v1/downstream-models").json()["data"]["items"]
         if x["id"] == mid][0]
    assert m["materialized"] is True and m["physical_table"] == tbl
    assert m["row_count"] == n1
    dd = api.get(f"/api/v1/downstream-models/{mid}/data").json()["data"]
    assert dd["total"] == n1 and dd["columns"][0] == "date_bucket"
    assert dd["columns"][1] == "dim_city"

    # 编辑：定义变更后旧物化表被拆除、状态复位
    r = api.put(f"/api/v1/downstream-models/{mid}", json={
        "code": "city_pay_daily_test", "name": "城市订单日汇总(测试)",
        "source_model_id": lm["id"], "granularity": "month",
        "metrics": [{"metric_code": "order_amount_sum", "dim_codes": ["dim_city"]}]})
    assert r.status_code == 200
    m = api.get(f"/api/v1/downstream-models/{mid}").json()["data"]
    assert m["materialized"] is False and m["physical_table"] is None
    from models import engine
    from sqlalchemy import text
    exists = engine.connect().execute(text(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=:t"),
        {"t": tbl}).scalar()
    assert exists == 0

    # 删除：元数据与（已拆除的）物化表均清理
    assert api.delete(f"/api/v1/downstream-models/{mid}").status_code == 200
    assert api.get(f"/api/v1/downstream-models/{mid}").status_code == 404


def test_downstream_validation_400(api):
    lm = _trade_wide_lm(api)
    # 复合指标需先展开为派生指标
    r = api.post("/api/v1/downstream-models", json={
        "code": "bad_composite_ds", "name": "错误", "source_model_id": lm["id"],
        "metrics": [{"metric_code": "avg_order_value", "dim_codes": ["dim_city"]}]})
    assert r.status_code == 400
    assert "复合" in r.json()["message"]
    # 指标过程表不在逻辑模型表范围内（退款表未 JOIN 进宽表）
    r = api.post("/api/v1/downstream-models", json={
        "code": "bad_table_ds", "name": "错误2", "source_model_id": lm["id"],
        "metrics": [{"metric_code": "refund_amount_sum", "dim_codes": ["dim_city"]}]})
    assert r.status_code == 400
    assert "物理表" in r.json()["message"]
    # 编码冲突 409
    r = api.post("/api/v1/downstream-models", json={
        "code": "city_order_daily", "name": "重复", "source_model_id": lm["id"],
        "metrics": [{"metric_code": "order_count", "dim_codes": ["dim_city"]}]})
    assert r.status_code == 409


def test_downstream_preview_no_materialize(api):
    """预览执行定义 SQL 但不落地"""
    lm = _trade_wide_lm(api)
    r = api.post("/api/v1/downstream-models", json={
        "code": "preview_ds", "name": "预览", "source_model_id": lm["id"],
        "metrics": [{"metric_code": "order_count", "dim_codes": ["dim_city"]}]})
    mid = r.json()["data"]["id"]
    p = api.post(f"/api/v1/downstream-models/{mid}/preview", params={"limit": 50})
    assert p.status_code == 200
    d = p.json()["data"]
    assert d["columns"][0] == "date_bucket" and "order_count" in d["columns"]
    assert 0 < len(d["rows"]) <= 50
    # 未物化，data 接口拒绝
    assert api.get(f"/api/v1/downstream-models/{mid}/data").status_code == 400
    api.delete(f"/api/v1/downstream-models/{mid}")


# ===================================================================
# 表级血缘（物理表 -> 逻辑模型 -> 下游模型 -> 物化表）
# ===================================================================

def test_lineage_tables_full_chain(api):
    r = api.get("/api/v1/lineage/tables")
    assert r.status_code == 200
    d = r.json()["data"]
    ids = {n["id"] for n in d["nodes"]}
    types = {n["type"] for n in d["nodes"]}
    assert {"table", "logical_model", "downstream_model"} <= types
    # 物理表（业务过程 + 维度表）与逻辑模型、种子下游模型
    assert "table:dwd_order_detail" in ids
    assert "table:dim_city" in ids
    assert "model:trade_wide_order" in ids
    assert "downstream:city_order_daily" in ids
    # 边：物理表 -> 逻辑模型（含 join_config 表）-> 下游模型
    edges = {(e["from"], e["to"]) for e in d["edges"]}
    assert ("table:dwd_order_detail", "model:trade_wide_order") in edges
    assert ("table:dim_city", "model:trade_wide_order") in edges
    assert ("model:trade_wide_order", "downstream:city_order_daily") in edges
    # 指标血缘端点不受影响
    assert api.get("/api/v1/lineage/avg_order_value").status_code == 200


def test_lineage_tables_after_materialize(api):
    """物化后表血缘出现 下游模型 -> 物化表 链路"""
    lm = _trade_wide_lm(api)
    r = api.post("/api/v1/downstream-models", json={
        "code": "lineage_ds", "name": "血缘测试", "source_model_id": lm["id"],
        "metrics": [{"metric_code": "order_count", "dim_codes": ["dim_city"]}]})
    mid = r.json()["data"]["id"]
    assert api.post(f"/api/v1/downstream-models/{mid}/materialize").status_code == 200
    d = api.get("/api/v1/lineage/tables").json()["data"]
    ids = {n["id"] for n in d["nodes"]}
    assert "table:dl_lineage_ds" in ids
    edges = {(e["from"], e["to"]) for e in d["edges"]}
    assert ("downstream:lineage_ds", "table:dl_lineage_ds") in edges
    api.delete(f"/api/v1/downstream-models/{mid}")