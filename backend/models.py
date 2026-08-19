"""统一指标维度管理平台 Demo - 元数据模型

参照阿里 Dataphin 逻辑层设计：
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
    ForeignKey, create_engine,
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
    status = Column(String(16), default=STATUS_PUBLISHED)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)


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


def init_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)


def get_session():
    return SessionLocal()