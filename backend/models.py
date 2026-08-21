"""统一指标维度管理平台 Demo - 元数据模型

参照阿里 DataMetric 逻辑层设计：
  物理表 -> 原子指标 -> 派生指标 -> 复合指标 -> 下游查询
逻辑层定义本身以元数据形式存储（元数据中心），查询时由 SQL 生成器动态拼装 SQL。

数据模型对齐需求文档 4.1：
  主题域(subject_domain) / 业务过程(business_process) / 原子指标(atomic_metric)
  维度(dimension) / 维度属性(dimension_attribute) / 派生指标(derived_metric)
  复合指标(composite_metric) / 逻辑模型(logical_model)
"""
import datetime
import os
from pathlib import Path

from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Date, JSON, Text,
    ForeignKey, UniqueConstraint, Index, create_engine, inspect, text,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

DB_PATH = os.environ.get(
    "METRIC_DB_PATH",
    str(Path(__file__).resolve().parent.parent / "metadata.db"),
)

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
Base = declarative_base()
SessionLocal = sessionmaker(bind=engine, autoflush=False)

STATUS_DRAFT = "DRAFT"
STATUS_PUBLISHED = "PUBLISHED"
STATUS_ARCHIVED = "ARCHIVED"
VALID_STATUS = (STATUS_DRAFT, STATUS_PUBLISHED, STATUS_ARCHIVED)


def now():
    return datetime.datetime.now()


# ---------------------------------------------------------------------------
# 元数据中心（逻辑层定义）
# ---------------------------------------------------------------------------

class SubjectDomain(Base):
    """主题域：业务领域的高层划分（需求文档 4.1.1）"""
    __tablename__ = "meta_subject_domain"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)   # 编码
    name = Column(String(128), nullable=False)              # 名称
    description = Column(Text, default="")                   # 描述
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)


class BusinessProcess(Base):
    """业务过程：不可拆分的业务事件，关联物理事实表（需求文档 4.1.2）"""
    __tablename__ = "meta_business_process"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    domain_id = Column(Integer, ForeignKey("meta_subject_domain.id"), nullable=False)
    physical_table = Column(String(128), nullable=False)     # 关联物理表
    date_field = Column(String(64), default="pay_date")      # 事实表日期字段
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    domain = relationship("SubjectDomain")
    fields = relationship("BusinessProcessField", cascade="all, delete-orphan",
                          order_by="BusinessProcessField.id")

    @property
    def domain_name(self):
        return self.domain.name if self.domain else ""


class Dimension(Base):
    """维度：观察数据的角度（分组依据）（需求文档 4.1.4）"""
    __tablename__ = "meta_dimension"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    domain_id = Column(Integer, ForeignKey("meta_subject_domain.id"), nullable=False)
    physical_table = Column(String(128), nullable=False)     # 维度物理表
    join_field = Column(String(64), nullable=False)          # 事实表关联字段
    name_field = Column(String(64), nullable=False)          # 展示名称字段
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    domain = relationship("SubjectDomain")
    attributes = relationship("DimensionAttribute", cascade="all, delete-orphan")

    @property
    def domain_name(self):
        return self.domain.name if self.domain else ""


class DimensionAttribute(Base):
    """维度属性：维度的具体描述字段（需求文档 4.1.5）"""
    __tablename__ = "meta_dimension_attribute"
    id = Column(Integer, primary_key=True)
    dimension_id = Column(Integer, ForeignKey("meta_dimension.id"), nullable=False)
    code = Column(String(64), nullable=False)
    name = Column(String(128), nullable=False)
    physical_field = Column(String(64), nullable=False)
    data_type = Column(String(32), default="STRING")


class BusinessProcessField(Base):
    """业务过程字段：业务过程物理表可度量/筛选/下钻的字段清单（需求文档 4.1.2 扩展）
    定义原子指标时从该列表中带出可选项，防止手填不存在的物理列"""
    __tablename__ = "meta_business_process_field"
    id = Column(Integer, primary_key=True)
    process_id = Column(Integer, ForeignKey("meta_business_process.id"), nullable=False)
    code = Column(String(64), nullable=False)     # 字段名（物理列名）
    name = Column(String(128), nullable=False)    # 显示名
    data_type = Column(String(32), default="STRING")
    __table_args__ = (
        UniqueConstraint("process_id", "code", name="uq_process_field_code"),
    )


class AtomicMetric(Base):
    """原子指标：业务过程 + 度量方式（需求文档 4.1.3）"""
    __tablename__ = "meta_atomic_metric"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    process_id = Column(Integer, ForeignKey("meta_business_process.id"), nullable=False)
    agg_function = Column(String(32), nullable=False)        # SUM/COUNT/AVG/MAX/MIN/COUNT_DISTINCT
    physical_field = Column(String(64), nullable=False)     # 物理字段
    data_type = Column(String(32), default="DECIMAL")       # DECIMAL/INT/BIGINT
    unit = Column(String(32), default="")                   # 单位
    owner = Column(String(64), default="")                 # 指标 Owner（责任人）
    cert_level = Column(String(16), default="UNVERIFIED")  # 认证等级 UNVERIFIED/COMMON/CERTIFIED/QUALITY
    biz_definition = Column(Text, default="")              # 业务口径文档
    status = Column(String(16), default=STATUS_DRAFT)       # DRAFT/PUBLISHED/ARCHIVED
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    process = relationship("BusinessProcess")

    @property
    def process_name(self):
        return self.process.name if self.process else ""


class DerivedMetric(Base):
    """派生指标：原子指标 + 时间周期 + 统计粒度 + 业务限定（需求文档 4.1.6）"""
    __tablename__ = "meta_derived_metric"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    atomic_id = Column(Integer, ForeignKey("meta_atomic_metric.id"), nullable=False)
    time_period = Column(String(8), default="custom")        # 1d/7d/30d/90d/ytd/custom
    dim_codes = Column(JSON, default=list)                   # 统计维度编码列表
    filters = Column(JSON, default=list)                     # 业务限定 [{field,op,value}]
    modifier_codes = Column(JSON, default=list)              # 引用的修饰词库编码（时间周期/业务限定/统计粒度可复用）
    compare_type = Column(String(16), default="none")        # none/yoy/mom/yoy_mom/cumulative 同比/环比/累计自动派生
    owner = Column(String(64), default="")                   # 指标 Owner（责任人）
    cert_level = Column(String(16), default="UNVERIFIED")    # 认证等级
    biz_definition = Column(Text, default="")                # 业务口径文档
    status = Column(String(16), default=STATUS_PUBLISHED)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    atomic = relationship("AtomicMetric")


class CompositeMetric(Base):
    """复合指标：派生/原子指标之间的四则运算（需求文档 4.1.7）"""
    __tablename__ = "meta_composite_metric"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    expression = Column(Text, nullable=False)                # 引用指标编码的运算式
    ref_codes = Column(JSON, default=list)                   # 引用的指标编码列表
    data_type = Column(String(32), default="DECIMAL")
    unit = Column(String(32), default="")
    owner = Column(String(64), default="")                 # 指标 Owner（责任人）
    cert_level = Column(String(16), default="UNVERIFIED")  # 认证等级
    biz_definition = Column(Text, default="")              # 业务口径文档
    status = Column(String(16), default=STATUS_PUBLISHED)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)


class MetricModifier(Base):
    """修饰词库：时间周期 / 业务限定 / 统计粒度 独立成库，派生指标引用而非写死
    config: time_period -> {"period": "7d"}；business_filter -> {"filters": [{field,op,value}]}
            granularity -> {"dim_codes": ["dim_city"]}"""
    __tablename__ = "meta_modifier"
    id = Column(Integer, primary_key=True)
    modifier_type = Column(String(32), nullable=False)     # time_period/business_filter/granularity
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    config = Column(JSON, default=dict)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    __table_args__ = (
        Index("ix_modifier_type", "modifier_type"),
    )


class LogicalModel(Base):
    """逻辑模型：物理表映射为逻辑层，支持多表 JOIN（需求文档 4.1.8）"""
    __tablename__ = "meta_logical_model"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    domain_id = Column(Integer, ForeignKey("meta_subject_domain.id"), nullable=False)
    physical_table = Column(String(128), nullable=False)     # 主物理表
    join_type = Column(String(32), default="SINGLE")         # SINGLE/JOIN
    join_config = Column(JSON, default=list)                 # [{table, on: "t.id = d.id"}]
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    domain = relationship("SubjectDomain")

    @property
    def domain_name(self):
        return self.domain.name if self.domain else ""


class DownstreamModel(Base):
    """下游模型：基于逻辑模型 + 指标集合生成的定义（指标汇总表），支持物化
    物化语义：definition_sql -> CREATE TABLE dl_{code} AS ...（同库落地）
    metrics: [{metric_code, dim_codes}]；granularity: day/week/month"""
    __tablename__ = "meta_downstream_model"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    source_model_id = Column(Integer, ForeignKey("meta_logical_model.id"), nullable=False)
    metrics = Column(JSON, default=list)         # [{metric_code, dim_codes}]
    granularity = Column(String(8), default="day")
    definition_sql = Column(Text, default="")    # 生成的定义 SQL（不落地）
    materialized = Column(Integer, default=0)    # 0/1 是否已物化
    physical_table = Column(String(128))         # 物化后的物理表名 dl_{code}
    row_count = Column(Integer)                  # 物化后行数
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    source_model = relationship("LogicalModel")

    @property
    def source_model_name(self):
        return self.source_model.name if self.source_model else ""


class DownstreamApp(Base):
    """下游应用：接入开放 API 的应用注册（Dataphin 应用管理）
    创建时生成 appkey/appsecret，开放接口凭 X-App-Key/X-App-Secret 认证"""
    __tablename__ = "meta_downstream_app"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    appkey = Column(String(64), unique=True, nullable=False)
    appsecret = Column(String(64), nullable=False)
    status = Column(String(16), default="ENABLED")   # ENABLED / DISABLED
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)


class Dataset(Base):
    """数据集：供下游报表/看板消费的数据资产
    source_type: downstream_model（读物化表 dl_xxx）/ metric_query（动态 SQL 实时计算）
    metric_query 源配置: metric_codes + dim_codes + granularity"""
    __tablename__ = "meta_dataset"
    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(128), nullable=False)
    source_type = Column(String(32), nullable=False)   # downstream_model / metric_query
    source_model_id = Column(Integer, ForeignKey("meta_downstream_model.id"))
    metric_codes = Column(JSON, default=list)
    dim_codes = Column(JSON, default=list)
    granularity = Column(String(8), default="day")
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    source_model = relationship("DownstreamModel")

    @property
    def source_model_name(self):
        return self.source_model.name if self.source_model else ""


class AppDatasetGrant(Base):
    """应用-数据集授权（多对多）：应用仅能调用已授权数据集"""
    __tablename__ = "meta_app_dataset"
    id = Column(Integer, primary_key=True)
    app_id = Column(Integer, ForeignKey("meta_downstream_app.id"), nullable=False)
    dataset_id = Column(Integer, ForeignKey("meta_dataset.id"), nullable=False)
    __table_args__ = (
        # 同一应用对同一数据集只允许一条授权
        UniqueConstraint("app_id", "dataset_id", name="uq_app_dataset"),
    )


class ApiCallLog(Base):
    """开放 API 调用日志（用量监控）"""
    __tablename__ = "meta_api_log"
    id = Column(Integer, primary_key=True)
    app_id = Column(Integer, ForeignKey("meta_downstream_app.id"), nullable=False)
    dataset_id = Column(Integer, ForeignKey("meta_dataset.id"), nullable=False)
    called_at = Column(DateTime, default=now)
    row_count = Column(Integer, default=0)
    duration_ms = Column(Integer, default=0)
    status = Column(String(32), default="success")    # success / 错误信息摘要
    __table_args__ = (
        Index("ix_api_log_app_called", "app_id", "called_at"),
    )


# ---------------------------------------------------------------------------
# 物理表（模拟数据源：dwd 事实表 + dim 维度表）
# ---------------------------------------------------------------------------

class DimCity(Base):
    __tablename__ = "dim_city"
    city_id = Column(Integer, primary_key=True)
    city_name = Column(String(32), nullable=False)
    province_name = Column(String(32))
    region = Column(String(32))


class DimCategory(Base):
    __tablename__ = "dim_category"
    category_id = Column(Integer, primary_key=True)
    category_name = Column(String(32), nullable=False)
    level = Column(Integer, default=1)


class DimUser(Base):
    __tablename__ = "dim_user"
    user_id = Column(Integer, primary_key=True)
    gender = Column(String(8))
    age_group = Column(String(16))
    register_date = Column(Date)


class DwdOrderDetail(Base):
    """下单事实表"""
    __tablename__ = "dwd_order_detail"
    id = Column(Integer, primary_key=True)
    order_id = Column(String(32), nullable=False)
    order_date = Column(Date, nullable=False)
    city_id = Column(Integer, nullable=False)
    category_id = Column(Integer, nullable=False)
    user_id = Column(Integer)
    order_amount = Column(Float, nullable=False)
    order_status = Column(String(16), default="PAID")
    __table_args__ = (
        Index("ix_dwd_order_date", "order_date"),
    )


class DwdPayDetail(Base):
    """支付事实表"""
    __tablename__ = "dwd_pay_detail"
    id = Column(Integer, primary_key=True)
    pay_id = Column(String(32), nullable=False)
    pay_date = Column(Date, nullable=False)
    city_id = Column(Integer, nullable=False)
    category_id = Column(Integer, nullable=False)
    user_id = Column(Integer)
    pay_amount = Column(Float, nullable=False)
    pay_channel = Column(String(16), default="WECHAT")
    __table_args__ = (
        Index("ix_dwd_pay_date", "pay_date"),
    )


class DwdRefundDetail(Base):
    """退款事实表"""
    __tablename__ = "dwd_refund_detail"
    id = Column(Integer, primary_key=True)
    refund_id = Column(String(32), nullable=False)
    refund_date = Column(Date, nullable=False)
    city_id = Column(Integer, nullable=False)
    category_id = Column(Integer, nullable=False)
    pay_id = Column(String(32))
    refund_amount = Column(Float, nullable=False)
    refund_reason = Column(String(32), default="质量原因")
    __table_args__ = (
        Index("ix_dwd_refund_date", "refund_date"),
    )


# ---------------------------------------------------------------------------
# 治理与运维（版本 / 审批 / 标签 / 编码规范 / 质量 / 告警 / 任务 / 调度）
# ---------------------------------------------------------------------------

ENTITY_TYPES = ("atomic_metric", "derived_metric", "composite_metric", "dimension", "logical_model", "downstream_model")


class MetricVersion(Base):
    """指标/维度/模型版本快照：每次更新前存档，支持回滚与变更历史追溯"""
    __tablename__ = "meta_metric_version"
    id = Column(Integer, primary_key=True)
    entity_type = Column(String(32), nullable=False)   # atomic_metric/derived_metric/...
    entity_id = Column(Integer, nullable=False)
    version_no = Column(String(16), nullable=False)    # v1/v2/...
    snapshot = Column(Text, nullable=False)            # 变更前全字段 JSON 快照
    change_type = Column(String(16), default="update") # update/status/approve/rollback
    change_note = Column(String(256), default="")
    created_at = Column(DateTime, default=now)
    __table_args__ = (
        Index("ix_metric_version_entity", "entity_type", "entity_id"),
    )


class Approval(Base):
    """审批单：提交发布 → 同意/驳回（单级审批流）"""
    __tablename__ = "meta_approval"
    id = Column(Integer, primary_key=True)
    entity_type = Column(String(32), nullable=False)
    entity_id = Column(Integer, nullable=False)
    entity_code = Column(String(64), nullable=False)
    entity_name = Column(String(128), default="")
    action = Column(String(16), default="publish")     # publish（当前仅发布动作）
    status = Column(String(16), default="PENDING")     # PENDING/APPROVED/REJECTED
    comment = Column(String(512), default="")          # 审批意见
    created_at = Column(DateTime, default=now)
    reviewed_at = Column(DateTime)
    __table_args__ = (
        Index("ix_approval_entity", "entity_type", "entity_id"),
        Index("ix_approval_status", "status"),
    )


class QualityRule(Base):
    """质量规则：对下游物化表执行校验（行数/波动/非空/新鲜度）"""
    __tablename__ = "meta_quality_rule"
    id = Column(Integer, primary_key=True)
    entity_type = Column(String(32), default="downstream_model")
    entity_id = Column(Integer, nullable=False)        # 下游模型 id
    rule_type = Column(String(32), nullable=False)     # row_count_min/row_count_change/non_null_rate/fresh_days
    params = Column(JSON, default=dict)                # {min_rows, max_change_pct, column, min_rate, max_days, ...}
    severity = Column(String(16), default="warning")   # info/warning/critical
    enabled = Column(Integer, default=1)
    last_check_at = Column(DateTime)
    last_result = Column(String(16))                   # ok/fail/error
    last_value = Column(String(64))                    # 最近一次校验结果值（如行数/波动%）
    last_message = Column(String(256), default="")
    created_at = Column(DateTime, default=now)
    __table_args__ = (
        Index("ix_quality_rule_entity", "entity_type", "entity_id"),
        Index("ix_quality_rule_enabled", "enabled"),
    )


class Alert(Base):
    """站内告警/通知：质量失败、任务失败、审批待办等"""
    __tablename__ = "meta_alert"
    id = Column(Integer, primary_key=True)
    level = Column(String(16), default="info")         # info/warning/error
    source_type = Column(String(32), default="")       # quality/task/approval/system
    source_id = Column(Integer)                        # 关联对象 id（规则/实例/审批单）
    message = Column(String(512), nullable=False)
    read = Column(Integer, default=0)
    created_at = Column(DateTime, default=now)
    __table_args__ = (
        Index("ix_alert_read", "read"),
        Index("ix_alert_source", "source_type", "source_id"),
    )


class TaskInstance(Base):
    """任务实例：物化/重导/质量检查/调度执行的历史记录（含失败重试）"""
    __tablename__ = "meta_task_instance"
    id = Column(Integer, primary_key=True)
    task_type = Column(String(32), nullable=False)     # materialize/reimport/quality_check
    entity_type = Column(String(32), default="downstream_model")
    entity_id = Column(Integer, nullable=False)
    entity_code = Column(String(64), default="")
    status = Column(String(16), default="RUNNING")     # RUNNING/SUCCESS/FAILED/SKIPPED
    trigger = Column(String(16), default="manual")     # manual/schedule/auto
    detail = Column(JSON, default=dict)                # 执行结果明细（deleted/inserted/rows...）
    error = Column(Text, default="")                   # 失败原因
    started_at = Column(DateTime, default=now)
    finished_at = Column(DateTime)
    __table_args__ = (
        Index("ix_task_entity", "entity_type", "entity_id"),
        Index("ix_task_status", "status"),
    )


class Schedule(Base):
    """周期调度：对下游模型定时物化/重导（daily 每天固定时刻 / interval 每 N 分钟）"""
    __tablename__ = "meta_schedule"
    id = Column(Integer, primary_key=True)
    entity_id = Column(Integer, nullable=False)        # 下游模型 id
    schedule_type = Column(String(16), default="daily") # daily/interval
    hour = Column(Integer, default=2)                  # daily：每天几点（0-23）
    minute = Column(Integer, default=0)                # daily：几分（0-59）
    interval_minutes = Column(Integer, default=60)     # interval：间隔分钟数
    action = Column(String(16), default="materialize") # materialize/reimport
    enabled = Column(Integer, default=1)
    last_run_at = Column(DateTime)
    next_run_at = Column(DateTime)
    created_at = Column(DateTime, default=now)
    __table_args__ = (
        Index("ix_schedule_enabled", "enabled"),
    )


class EntityTag(Base):
    """实体标签：指标/维度可打任意标签，支持按标签过滤与资产检索"""
    __tablename__ = "meta_entity_tag"
    id = Column(Integer, primary_key=True)
    entity_type = Column(String(32), nullable=False)
    entity_id = Column(Integer, nullable=False)
    tag = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=now)
    __table_args__ = (
        # 同一实体同一标签唯一
        UniqueConstraint("entity_type", "entity_id", "tag", name="uq_entity_tag"),
    )


class CodeRule(Base):
    """编码规范：各实体类型的编码正则规则（seed 内置，创建/更新时校验）"""
    __tablename__ = "meta_code_rule"
    id = Column(Integer, primary_key=True)
    entity_type = Column(String(32), unique=True, nullable=False)
    pattern = Column(String(256), nullable=False)
    example = Column(String(128), default="")


CERT_LEVELS = ("UNVERIFIED", "COMMON", "CERTIFIED", "QUALITY")
COMPARE_TYPES = ("none", "yoy", "mom", "yoy_mom", "cumulative")
MODIFIER_TYPES = ("time_period", "business_filter", "granularity")


def ensure_schema():
    """轻量迁移（幂等）：旧库启动时补齐新增表与列，无需重建数据。
    SQLite 不支持 ALTER 修改列，仅 ADD COLUMN（带默认值），新表由 create_all 补建"""
    Base.metadata.create_all(engine)
    new_cols = {
        "meta_atomic_metric": [
            ("owner", "VARCHAR(64) DEFAULT ''"),
            ("cert_level", "VARCHAR(16) DEFAULT 'UNVERIFIED'"),
            ("biz_definition", "TEXT DEFAULT ''"),
        ],
        "meta_derived_metric": [
            ("modifier_codes", "TEXT DEFAULT '[]'"),
            ("compare_type", "VARCHAR(16) DEFAULT 'none'"),
            ("owner", "VARCHAR(64) DEFAULT ''"),
            ("cert_level", "VARCHAR(16) DEFAULT 'UNVERIFIED'"),
            ("biz_definition", "TEXT DEFAULT ''"),
        ],
        "meta_composite_metric": [
            ("owner", "VARCHAR(64) DEFAULT ''"),
            ("cert_level", "VARCHAR(16) DEFAULT 'UNVERIFIED'"),
            ("biz_definition", "TEXT DEFAULT ''"),
        ],
    }
    insp = __import__("sqlalchemy").inspect(engine)
    for table, cols in new_cols.items():
        if table not in insp.get_table_names():
            continue
        existing = {c["name"] for c in insp.get_columns(table)}
        with engine.begin() as conn:
            for col, ddl in cols:
                if col not in existing:
                    conn.execute(
                        text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))


def init_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)


def get_session():
    return SessionLocal()