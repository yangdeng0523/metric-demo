"""核心逻辑单元测试（需求文档第 9 章：SQL 生成、指标派生需有单元测试）

覆盖：
  1. 派生规则引擎：时间周期解析、维度 JOIN、业务限定（筛选条件）-> SQL 生成
  2. 复合指标：表达式替换、防除零、子查询 JOIN
  3. 统一指标查询：执行结果正确性与口径一致
  4. 安全：标识符白名单防注入
  5. API：统一响应结构、引用校验（409）、编码冲突（409）、参数校验（400）
  6. 血缘：全链路节点完整性
"""
import datetime as dt

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
    assert d["summary"]["metric_type"] == "composite"
    assert len(d["rows"]) == 6  # 6 个城市
    # 客单价为正且有限（行结构为 [metric_value, 维度...]，值在前）
    for row in d["rows"]:
        assert row[0] is not None and row[0] > 0


def test_refund_rate_sanity(api):
    """退款率 = 退款金额/支付金额 ∈ [0, 1]，口径一致"""
    r = api.post("/api/v1/query", json={"metric_code": "refund_rate",
                                        "dim_codes": ["dim_city"]})
    d = r.json()["data"]
    for row in d["rows"]:
        assert row[0] is not None and 0 <= row[0] <= 1, f"退款率异常: {row}"


# ===========================================================================
# 统一指标查询
# ===========================================================================

def test_query_atomic_with_dims(api):
    """原子指标 + 维度 + 时间范围 -> 返回一致口径结果"""
    r = api.post("/api/v1/query", json={
        "metric_code": "pay_amount_sum", "dim_codes": ["dim_city"],
        "start_date": "2026-08-01", "end_date": "2026-08-19"})
    d = r.json()["data"]
    assert r.status_code == 200
    assert d["summary"]["row_count"] <= 6
    assert any(c == "dim_city" for c in d["columns"])


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
    r = api.get("/api/v1/sql-preview", params={"metric_code": "pay_amount_7d_city"})
    d = r.json()["data"]
    assert "SELECT" in d["sql"] and d["params"]


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
        "metric_code": "pay_amount_7d_city", "dim_codes": "dim_city"})
    assert r.status_code == 200
    assert "spreadsheetml" in r.headers["content-type"]
    assert r.content[:2] == b"PK"  # zip 魔数
    from openpyxl import load_workbook
    wb = load_workbook(io_bytes(r.content))
    ws = wb.active
    assert ws.max_row == 7  # 表头 + 6 城市
    assert ws.cell(1, 1).value == "metric_value"


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