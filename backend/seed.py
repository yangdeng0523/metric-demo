"""种子数据：电商交易 Demo 场景

按需求文档第 7 章：
- 3 个业务过程：下单 / 支付 / 退款
- 5 个原子指标、3 个维度、4 个派生指标、2 个复合指标、1 个逻辑模型
- 事实表样例数据（最近 30 天）
"""
import datetime as dt
import random
import secrets

from models import (
    init_db, get_session, STATUS_PUBLISHED,
    SubjectDomain, BusinessProcess, Dimension, DimensionAttribute,
    AtomicMetric, DerivedMetric, CompositeMetric, LogicalModel, DownstreamModel,
    DownstreamApp, Dataset, AppDatasetGrant,
    DimCity, DimCategory, DimUser,
    DwdOrderDetail, DwdPayDetail, DwdRefundDetail,
)
from sql_generator import SQLGenerator

random.seed(42)

CITIES = [
    (1, "北京", "北京", "华北"), (2, "上海", "上海", "华东"),
    (3, "广州", "广东", "华南"), (4, "深圳", "广东", "华南"),
    (5, "杭州", "浙江", "华东"), (6, "成都", "四川", "西南"),
]
CATEGORIES = [
    (1, "数码电器", 1), (2, "服饰鞋包", 1),
    (3, "美妆个护", 1), (4, "食品生鲜", 1), (5, "家居日用", 1),
]
STATUSES = ["PAID", "PAID", "PAID", "SHIPPED", "COMPLETED", "CANCELLED"]
AGE_GROUPS = ["<18", "18-25", "26-35", "36-45", "46+"]


def seed_metadata(s):
    # 主题域
    domain = SubjectDomain(code="trade", name="交易域",
                           description="电商交易相关业务过程与指标", sort_order=1)
    s.add(domain)
    s.flush()

    # 业务过程 -> 物理事实表（需求文档 7.1）
    processes = [
        BusinessProcess(code="order", name="下单", domain_id=domain.id,
                        physical_table="dwd_order_detail", date_field="order_date",
                        description="用户提交订单的业务事件"),
        BusinessProcess(code="pay", name="支付", domain_id=domain.id,
                        physical_table="dwd_pay_detail", date_field="pay_date",
                        description="订单完成支付"),
        BusinessProcess(code="refund", name="退款", domain_id=domain.id,
                        physical_table="dwd_refund_detail", date_field="refund_date",
                        description="订单发生退款"),
    ]
    s.add_all(processes)
    s.flush()

    # 维度（需求文档 7.2.2）
    dims = [
        Dimension(code="dim_city", name="城市", domain_id=domain.id,
                  physical_table="dim_city", join_field="city_id", name_field="city_name",
                  description="下单/支付/退款发生的城市"),
        Dimension(code="dim_category", name="商品类目", domain_id=domain.id,
                  physical_table="dim_category", join_field="category_id",
                  name_field="category_name", description="商品所属类目"),
        Dimension(code="dim_user", name="用户", domain_id=domain.id,
                  physical_table="dim_user", join_field="user_id", name_field="age_group",
                  description="下单用户（默认展示年龄段）"),
    ]
    s.add_all(dims)
    s.flush()

    attrs = [
        DimensionAttribute(dimension_id=dims[0].id, code="city_name", name="城市名称",
                           physical_field="city_name"),
        DimensionAttribute(dimension_id=dims[0].id, code="province", name="省份",
                           physical_field="province_name"),
        DimensionAttribute(dimension_id=dims[0].id, code="region", name="大区",
                           physical_field="region"),
        DimensionAttribute(dimension_id=dims[1].id, code="category_name", name="类目名称",
                           physical_field="category_name"),
        DimensionAttribute(dimension_id=dims[1].id, code="level", name="类目层级",
                           physical_field="level", data_type="INT"),
        DimensionAttribute(dimension_id=dims[2].id, code="gender", name="性别",
                           physical_field="gender"),
        DimensionAttribute(dimension_id=dims[2].id, code="age_group", name="年龄段",
                           physical_field="age_group"),
    ]
    s.add_all(attrs)

    # 原子指标（需求文档 7.2.1）
    atomics = [
        AtomicMetric(code="order_count", name="下单次数", process_id=processes[0].id,
                     agg_function="COUNT", physical_field="order_id",
                     data_type="BIGINT", unit="次", status=STATUS_PUBLISHED,
                     description="统计订单明细行数（唯一订单）"),
        AtomicMetric(code="order_amount_sum", name="下单金额", process_id=processes[0].id,
                     agg_function="SUM", physical_field="order_amount",
                     data_type="DECIMAL", unit="元", status=STATUS_PUBLISHED,
                     description="订单商品金额合计"),
        AtomicMetric(code="pay_amount_sum", name="支付金额", process_id=processes[1].id,
                     agg_function="SUM", physical_field="pay_amount",
                     data_type="DECIMAL", unit="元", status=STATUS_PUBLISHED,
                     description="实际支付金额合计（口径：支付成功）"),
        AtomicMetric(code="pay_count", name="支付笔数", process_id=processes[1].id,
                     agg_function="COUNT", physical_field="pay_id",
                     data_type="BIGINT", unit="次", status=STATUS_PUBLISHED,
                     description="支付成功笔数"),
        AtomicMetric(code="refund_amount_sum", name="退款金额", process_id=processes[2].id,
                     agg_function="SUM", physical_field="refund_amount",
                     data_type="DECIMAL", unit="元", status=STATUS_PUBLISHED,
                     description="退款金额合计"),
    ]
    s.add_all(atomics)
    s.flush()

    # 派生指标（需求文档 7.2.3）
    derived = [
        DerivedMetric(code="pay_amount_7d_city", name="最近7天各城市支付金额",
                      atomic_id=atomics[2].id, time_period="7d",
                      dim_codes=["dim_city"], filters=[],
                      description="最近7天按城市汇总的支付金额"),
        DerivedMetric(code="pay_count_7d_city", name="最近7天各城市支付笔数",
                      atomic_id=atomics[3].id, time_period="7d",
                      dim_codes=["dim_city"], filters=[],
                      description="最近7天按城市汇总的支付笔数"),
        DerivedMetric(code="order_amount_30d_cat", name="最近30天各类目下单金额",
                      atomic_id=atomics[1].id, time_period="30d",
                      dim_codes=["dim_category"],
                      filters=[{"field": "order_status", "op": "IN",
                                "value": ["PAID", "SHIPPED"]}],
                      description="最近30天按类目汇总、仅统计有效订单的下单金额（业务限定）"),
        DerivedMetric(code="refund_amount_7d_city", name="最近7天各城市退款金额",
                      atomic_id=atomics[4].id, time_period="7d",
                      dim_codes=["dim_city"], filters=[],
                      description="最近7天按城市汇总退款金额"),
    ]
    s.add_all(derived)

    # 复合指标（需求文档 7.2.4）
    composites = [
        CompositeMetric(code="avg_order_value", name="客单价",
                        expression="pay_amount_7d_city / pay_count_7d_city",
                        ref_codes=["pay_amount_7d_city", "pay_count_7d_city"],
                        data_type="DECIMAL", unit="元/笔",
                        description="平均每笔支付金额"),
        CompositeMetric(code="refund_rate", name="退款率",
                        expression="refund_amount_7d_city / pay_amount_7d_city",
                        ref_codes=["refund_amount_7d_city", "pay_amount_7d_city"],
                        data_type="DECIMAL", unit="%",
                        description="退款金额占支付金额比例"),
    ]
    s.add_all(composites)

    # 逻辑模型：交易宽表（订单事实表 JOIN 城市维度）
    lm = LogicalModel(
        code="trade_wide_order", name="订单交易宽表", domain_id=domain.id,
        physical_table="dwd_order_detail", join_type="JOIN",
        join_config=[{"table": "dim_city", "on": "t.city_id = d0.city_id", "alias": "d0"},
                     {"table": "dim_category", "on": "t.category_id = d1.category_id", "alias": "d1"}],
        description="订单明细 JOIN 城市/类目维度，供下游宽表查询使用")
    s.add(lm)
    s.flush()  # 先落库获得逻辑模型 id，供下游模型引用

    # 下游模型（指标汇总表，基于逻辑模型生成，未物化；可 POST .../materialize 落地）
    # 注意：definition_sql 在 main() 提交事务后生成（SQL 生成需跨会话读取维度元数据）
    ds = DownstreamModel(
        code="city_order_daily", name="城市订单日汇总", source_model_id=lm.id,
        metrics=[{"metric_code": "order_amount_sum", "dim_codes": ["dim_city"]},
                 {"metric_code": "order_count", "dim_codes": ["dim_city"]}],
        granularity="day",
        description="按城市+日汇总的订单金额/笔数 DWS 表，支持物化为 dl_city_order_daily")
    s.add(ds)
    s.flush()

    # 下游应用（开放 API 接入方）
    apps = [
        DownstreamApp(code="report_bi", name="报表看板系统", appkey=secrets.token_hex(10),
                      appsecret=secrets.token_urlsafe(24), description="BI 报表/看板（读 DWS 数据集）"),
        DownstreamApp(code="data_science", name="数据科学平台", appkey=secrets.token_hex(10),
                      appsecret=secrets.token_urlsafe(24), description="实时指标分析（直接查询指标）"),
    ]
    s.add_all(apps)
    s.flush()

    # 数据集：下游模型（物化表）/ 指标查询（动态 SQL）两种源
    datasets = [
        Dataset(code="ds_city_daily", name="城市订单日报", source_type="downstream_model",
                source_model_id=ds.id, granularity="day",
                description="城市+日粒度的订单金额/笔数汇总（源：dl_city_order_daily 物化表）"),
        Dataset(code="ds_city_metrics", name="城市核心指标", source_type="metric_query",
                metric_codes=["order_amount_sum", "order_count"],
                dim_codes=["dim_city"], granularity="day",
                description="城市维度实时指标查询（下单金额/下单次数，动态 SQL 计算）"),
    ]
    s.add_all(datasets)
    s.flush()

    # 授权：报表看板系统 -> 两个数据集；数据科学平台 -> 仅实时指标
    s.add_all([
        AppDatasetGrant(app_id=apps[0].id, dataset_id=datasets[0].id),
        AppDatasetGrant(app_id=apps[0].id, dataset_id=datasets[1].id),
        AppDatasetGrant(app_id=apps[1].id, dataset_id=datasets[1].id),
    ])


def seed_physical(s):
    today = dt.date.today()
    start = today - dt.timedelta(days=29)

    # 维度表
    s.add_all([DimCity(city_id=i, city_name=c, province_name=p, region=r)
               for i, c, p, r in CITIES])
    s.add_all([DimCategory(category_id=i, category_name=n, level=l)
               for i, n, l in CATEGORIES])
    s.add_all([DimUser(user_id=i,
                       gender=random.choice(["男", "女"]),
                       age_group=random.choice(AGE_GROUPS),
                       register_date=start - dt.timedelta(days=random.randint(30, 1000)))
               for i in range(1, 201)])

    # 事实表：30 天 x 6 城市 x 5 类目
    city_weights = [1.0, 1.1, 0.8, 0.9, 0.7, 0.5]
    cat_weights = [1.4, 1.2, 1.0, 0.8, 0.7]
    oid, pid, rid = 1, 1, 1
    for d in range(30):
        day = start + dt.timedelta(days=d)
        trend = 1.0 + d * 0.01  # 轻微增长趋势
        for (ci, (city_id, _, _, _)), cw in zip(enumerate(CITIES), city_weights):
            for (ki, (cat_id, _, _)), kw in zip(enumerate(CATEGORIES), cat_weights):
                n_orders = int(random.randint(4, 12) * cw * kw * trend)
                for _ in range(n_orders):
                    amount = round(random.uniform(30, 1200) * kw, 2)
                    status = random.choice(STATUSES)
                    s.add(DwdOrderDetail(
                        order_id=f"O{oid:07d}", order_date=day, city_id=city_id,
                        category_id=cat_id, user_id=random.randint(1, 200),
                        order_amount=amount, order_status=status))
                    oid += 1
                    if status in ("PAID", "SHIPPED", "COMPLETED"):
                        s.add(DwdPayDetail(
                            pay_id=f"P{pid:07d}", pay_date=day, city_id=city_id,
                            category_id=cat_id, user_id=random.randint(1, 200),
                            pay_amount=amount,
                            pay_channel=random.choice(["WECHAT", "ALIPAY", "BANK"])))
                        pid += 1
                        if random.random() < 0.08:  # 8% 退款率
                            s.add(DwdRefundDetail(
                                refund_id=f"R{rid:07d}", refund_date=day,
                                city_id=city_id, category_id=cat_id,
                                pay_id=f"P{pid - 1:07d}",
                                refund_amount=round(amount * random.uniform(0.3, 1.0), 2),
                                refund_reason=random.choice(["质量原因", "七天无理由", "发货延迟"])))
                            rid += 1


def main():
    init_db()
    s = get_session()
    try:
        seed_metadata(s)
        seed_physical(s)
        s.commit()
        # 提交后再生成下游模型定义 SQL（生成过程需跨会话读取维度元数据）
        ds = s.query(DownstreamModel).filter_by(code="city_order_daily").first()
        ds.definition_sql = SQLGenerator().generate_downstream_sql(ds)[0]
        s.commit()
        print("种子数据完成：元数据 + 物理事实表（30 天）")
        for tbl in ["meta_atomic_metric", "meta_derived_metric", "meta_composite_metric",
                    "meta_logical_model", "meta_downstream_model",
                    "meta_downstream_app", "meta_dataset", "meta_app_dataset",
                    "dwd_order_detail", "dwd_pay_detail", "dwd_refund_detail"]:
            from sqlalchemy import text
            from models import engine
            n = engine.connect().execute(text(f"SELECT COUNT(*) FROM {tbl}")).scalar()
            print(f"  {tbl}: {n} rows")
    finally:
        s.close()


if __name__ == "__main__":
    main()