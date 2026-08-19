"""统一指标维度管理平台 Demo - API 服务

对齐需求文档 6 章 API 设计：
  Base URL: /api/v1（同时以 /api 挂载一份，兼容旧版本前端路径）
  统一响应: {code, message, data}；分页: page/page_size；错误码: 0=成功/400/404/409/500

功能覆盖（需求文档 1.2 目标，P0/P1/P2 全部落地）：
  P0 指标定义与管理  原子/派生/复合指标 定义、编辑、查询（CRUD + 状态 + 引用校验）
  P0 维度定义与管理  维度及维度属性 统一定义和管理（CRUD）
  P0 派生规则引擎    原子指标 + 修饰词(时间周期/统计维度/筛选条件) -> 派生指标，动态 SQL
  P1 统一指标查询    指标 + 维度组合，自动生成并执行 SQL；SQL 透明预览；Excel 导出
  P1 逻辑模型映射    物理表 -> 逻辑模型，多表 JOIN 定义与 SQL 预览
  P2 血缘追溯        物理字段 -> 原子 -> 派生 -> 复合，全链路影响分析/根因追溯
  P2 可视化看板      前端基于查询结果渲染图表
"""
import datetime as dt
import io
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import or_, text

from models import (
    get_session, engine, STATUS_DRAFT, STATUS_PUBLISHED,
    SubjectDomain, BusinessProcess, Dimension, DimensionAttribute,
    AtomicMetric, DerivedMetric, CompositeMetric, LogicalModel, DownstreamModel,
)
from sql_generator import SQLGenerator, MetricNotFoundError, _safe_ident, GRANULARITY_FMT

AGG_FUNCTIONS = ("SUM", "COUNT", "AVG", "MAX", "MIN", "COUNT_DISTINCT")
TIME_PERIODS = ("1d", "7d", "30d", "90d", "ytd", "custom")
FILTER_OPS = ("=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN", "BETWEEN", "LIKE")

router = APIRouter()
gen = SQLGenerator()
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


# ---------------------------------------------------------------------------
# 统一响应结构：{code, message, data}（文档 6.1）
# ---------------------------------------------------------------------------

def ok(data=None):
    return {"code": 0, "message": "ok", "data": data}


def _get_or_404(s, model, obj_id: int, label: str):
    obj = s.query(model).get(obj_id)
    if not obj:
        raise HTTPException(404, f"{label}不存在: id={obj_id}")
    return obj


def _check_code(s, model, code: str, exclude_id: Optional[int] = None):
    q = s.query(model).filter_by(code=code)
    if exclude_id is not None:
        q = q.filter(model.id != exclude_id)
    if q.first():
        raise HTTPException(409, f"编码已存在: {code}")


def _check_status_arg(status: str):
    if status not in (STATUS_DRAFT, STATUS_PUBLISHED, "ARCHIVED"):
        raise HTTPException(400, f"非法状态: {status}，可选 DRAFT/PUBLISHED/ARCHIVED")


def _check_filters(s, filters: list):
    """筛选条件（业务限定）白名单校验：字段名合法、操作符支持"""
    for f in filters or []:
        if not isinstance(f, dict) or "field" not in f or "op" not in f:
            raise HTTPException(400, f"筛选条件格式错误: {f}，需含 field/op/value")
        if f["op"] not in FILTER_OPS:
            raise HTTPException(400, f"不支持的操作符: {f['op']}")
        if not f["field"] or not str(f["field"]).replace("_", "").isalnum():
            raise HTTPException(400, f"非法字段名: {f['field']}")


def _check_dims(s, dim_codes: list):
    for dc in dim_codes or []:
        if not s.query(Dimension).filter_by(code=dc).first():
            raise HTTPException(400, f"维度不存在: {dc}")


def _metric_sql(code: str, start_date=None, end_date=None):
    """生成指标 SQL（口径透明）；custom 周期无参数时用最近 7 天示例"""
    try:
        mtype, _mname, sql, params = gen.generate(code, None, start_date, end_date)
    except ValueError:
        end = dt.date.today()
        start = end - dt.timedelta(days=7)
        mtype, _mname, sql, params = gen.generate(
            code, None, start.isoformat(), end.isoformat())
    return mtype, sql, {k: str(v) for k, v in params.items()}


# ---------------------------------------------------------------------------
# Pydantic 请求模型
# ---------------------------------------------------------------------------

class DomainIn(BaseModel):
    code: str
    name: str
    description: str = ""
    sort_order: int = 0


class ProcessIn(BaseModel):
    code: str
    name: str
    domain_id: int
    physical_table: str
    date_field: str = "order_date"
    description: str = ""


class AtomicIn(BaseModel):
    code: str
    name: str
    process_id: int
    agg_function: str
    physical_field: str
    data_type: str = "DECIMAL"
    unit: str = ""
    description: str = ""
    status: str = STATUS_DRAFT


class DimensionIn(BaseModel):
    code: str
    name: str
    domain_id: int
    physical_table: str
    join_field: str
    name_field: str
    description: str = ""


class AttrIn(BaseModel):
    code: str
    name: str
    physical_field: str
    data_type: str = "STRING"


class DerivedIn(BaseModel):
    code: str
    name: str
    atomic_code: str
    time_period: str = "7d"
    dim_codes: list = []
    filters: list = []
    description: str = ""
    status: str = STATUS_PUBLISHED


class CompositeIn(BaseModel):
    code: str
    name: str
    expression: str
    ref_codes: list
    data_type: str = "DECIMAL"
    unit: str = ""
    description: str = ""
    status: str = STATUS_PUBLISHED


class LogicalModelIn(BaseModel):
    code: str
    name: str
    domain_id: int
    physical_table: str
    join_type: str = "SINGLE"
    join_config: list = []
    description: str = ""


class StatusIn(BaseModel):
    status: str


class QueryRequest(BaseModel):
    metric_code: Optional[str] = None            # 单指标（兼容旧请求）
    metric_codes: Optional[list] = None          # 多指标（优先）
    dim_codes: list = []
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    granularity: str = "day"                     # day/week/month 日期粒度


# ===========================================================================
# 5.1 主题域管理
# ===========================================================================

@router.post("/domains", tags=["主题域"])
def create_domain(body: DomainIn):
    s = get_session()
    try:
        _check_code(s, SubjectDomain, body.code)
        d = SubjectDomain(**body.dict())
        s.add(d)
        s.commit()
        return ok({"id": d.id, "code": d.code})
    finally:
        s.close()


@router.get("/domains", tags=["主题域"])
def list_domains(page: int = 1, page_size: int = 20, keyword: str = ""):
    s = get_session()
    try:
        q = s.query(SubjectDomain)
        if keyword:
            q = q.filter(or_(SubjectDomain.code.like(f"%{keyword}%"),
                             SubjectDomain.name.like(f"%{keyword}%")))
        total = q.count()
        rows = (q.order_by(SubjectDomain.sort_order)
                .offset((page - 1) * page_size).limit(page_size).all())
        items = [{
            "id": d.id, "code": d.code, "name": d.name,
            "description": d.description, "sort_order": d.sort_order,
            "process_count": s.query(BusinessProcess).filter_by(domain_id=d.id).count(),
            "dimension_count": s.query(Dimension).filter_by(domain_id=d.id).count(),
        } for d in rows]
        return ok({"items": items, "total": total, "page": page, "page_size": page_size})
    finally:
        s.close()


@router.get("/domains/{domain_id}", tags=["主题域"])
def get_domain(domain_id: int):
    s = get_session()
    try:
        d = _get_or_404(s, SubjectDomain, domain_id, "主题域")
        return ok({
            "id": d.id, "code": d.code, "name": d.name,
            "description": d.description, "sort_order": d.sort_order,
            "processes": [{"id": p.id, "code": p.code, "name": p.name}
                          for p in s.query(BusinessProcess).filter_by(domain_id=d.id).all()],
            "dimensions": [{"id": dm.id, "code": dm.code, "name": dm.name}
                           for dm in s.query(Dimension).filter_by(domain_id=d.id).all()],
        })
    finally:
        s.close()


@router.put("/domains/{domain_id}", tags=["主题域"])
def update_domain(domain_id: int, body: DomainIn):
    s = get_session()
    try:
        d = _get_or_404(s, SubjectDomain, domain_id, "主题域")
        _check_code(s, SubjectDomain, body.code, exclude_id=domain_id)
        for k, v in body.dict().items():
            setattr(d, k, v)
        s.commit()
        return ok({"id": d.id})
    finally:
        s.close()


@router.delete("/domains/{domain_id}", tags=["主题域"])
def delete_domain(domain_id: int):
    """删除校验：有下属业务过程/维度则禁止（用户故事 5.1）"""
    s = get_session()
    try:
        d = _get_or_404(s, SubjectDomain, domain_id, "主题域")
        n1 = s.query(BusinessProcess).filter_by(domain_id=domain_id).count()
        n2 = s.query(Dimension).filter_by(domain_id=domain_id).count()
        if n1 or n2:
            raise HTTPException(409, f"主题域 {d.name} 下有 {n1} 个业务过程、{n2} 个维度，禁止删除")
        s.delete(d)
        s.commit()
        return ok({"deleted": domain_id})
    finally:
        s.close()


# ===========================================================================
# 5.2 业务过程管理
# ===========================================================================

@router.post("/processes", tags=["业务过程"])
def create_process(body: ProcessIn):
    s = get_session()
    try:
        _check_code(s, BusinessProcess, body.code)
        _get_or_404(s, SubjectDomain, body.domain_id, "主题域")
        p = BusinessProcess(**body.dict())
        s.add(p)
        s.commit()
        return ok({"id": p.id, "code": p.code})
    finally:
        s.close()


@router.get("/processes", tags=["业务过程"])
def list_processes(domain_id: Optional[int] = None, keyword: str = ""):
    s = get_session()
    try:
        q = s.query(BusinessProcess)
        if domain_id:
            q = q.filter_by(domain_id=domain_id)
        if keyword:
            q = q.filter(or_(BusinessProcess.code.like(f"%{keyword}%"),
                             BusinessProcess.name.like(f"%{keyword}%")))
        rows = q.order_by(BusinessProcess.id).all()
        items = [{
            "id": p.id, "code": p.code, "name": p.name,
            "domain_id": p.domain_id, "domain_name": p.domain_name,
            "physical_table": p.physical_table, "date_field": p.date_field,
            "description": p.description,
            "atomic_count": s.query(AtomicMetric).filter_by(process_id=p.id).count(),
        } for p in rows]
        return ok(items)
    finally:
        s.close()


@router.get("/processes/{process_id}", tags=["业务过程"])
def get_process(process_id: int):
    """详情含下属原子指标列表（用户故事：查看过程下所有原子指标）"""
    s = get_session()
    try:
        p = _get_or_404(s, BusinessProcess, process_id, "业务过程")
        atomics = [{"id": a.id, "code": a.code, "name": a.name,
                    "agg_function": a.agg_function, "physical_field": a.physical_field}
                   for a in s.query(AtomicMetric).filter_by(process_id=process_id).all()]
        return ok({
            "id": p.id, "code": p.code, "name": p.name,
            "domain_id": p.domain_id, "domain_name": p.domain_name,
            "physical_table": p.physical_table, "date_field": p.date_field,
            "description": p.description, "atomics": atomics,
        })
    finally:
        s.close()


@router.put("/processes/{process_id}", tags=["业务过程"])
def update_process(process_id: int, body: ProcessIn):
    s = get_session()
    try:
        p = _get_or_404(s, BusinessProcess, process_id, "业务过程")
        _check_code(s, BusinessProcess, body.code, exclude_id=process_id)
        _get_or_404(s, SubjectDomain, body.domain_id, "主题域")
        for k, v in body.dict().items():
            setattr(p, k, v)
        s.commit()
        return ok({"id": p.id})
    finally:
        s.close()


@router.delete("/processes/{process_id}", tags=["业务过程"])
def delete_process(process_id: int):
    """删除校验：有下属原子指标则禁止删除"""
    s = get_session()
    try:
        p = _get_or_404(s, BusinessProcess, process_id, "业务过程")
        n = s.query(AtomicMetric).filter_by(process_id=process_id).count()
        if n:
            raise HTTPException(409, f"业务过程 {p.name} 下有 {n} 个原子指标，禁止删除")
        s.delete(p)
        s.commit()
        return ok({"deleted": process_id})
    finally:
        s.close()


# ===========================================================================
# 5.3 原子指标管理
# ===========================================================================

@router.post("/atomic-metrics", tags=["原子指标"])
def create_atomic(body: AtomicIn):
    s = get_session()
    try:
        _check_code(s, AtomicMetric, body.code)
        _get_or_404(s, BusinessProcess, body.process_id, "业务过程")
        if body.agg_function not in AGG_FUNCTIONS:
            raise HTTPException(400, f"非法聚合方式: {body.agg_function}，可选 {AGG_FUNCTIONS}")
        _check_status_arg(body.status)
        a = AtomicMetric(**body.dict())
        s.add(a)
        s.commit()
        return ok({"id": a.id, "code": a.code})
    finally:
        s.close()


@router.get("/atomic-metrics", tags=["原子指标"])
def list_atomic_metrics(process_id: Optional[int] = None, status: Optional[str] = None,
                        keyword: str = "", page: int = 1, page_size: int = 20):
    s = get_session()
    try:
        q = s.query(AtomicMetric)
        if process_id:
            q = q.filter_by(process_id=process_id)
        if status:
            q = q.filter_by(status=status)
        if keyword:
            q = q.filter(or_(AtomicMetric.code.like(f"%{keyword}%"),
                             AtomicMetric.name.like(f"%{keyword}%")))
        total = q.count()
        rows = (q.order_by(AtomicMetric.id)
                .offset((page - 1) * page_size).limit(page_size).all())
        items = [{
            "id": m.id, "code": m.code, "name": m.name,
            "process_id": m.process_id, "process_name": m.process_name,
            "physical_table": m.process.physical_table,
            "agg_function": m.agg_function, "physical_field": m.physical_field,
            "data_type": m.data_type, "unit": m.unit, "status": m.status,
            "description": m.description,
        } for m in rows]
        return ok({"items": items, "total": total, "page": page, "page_size": page_size})
    finally:
        s.close()


@router.get("/atomic-metrics/{metric_id}", tags=["原子指标"])
def get_atomic(metric_id: int):
    """详情含引用此指标的派生指标列表（用户故事：查看被哪些派生引用）"""
    s = get_session()
    try:
        m = _get_or_404(s, AtomicMetric, metric_id, "原子指标")
        derived = s.query(DerivedMetric).filter_by(atomic_id=metric_id).all()
        return ok({
            "id": m.id, "code": m.code, "name": m.name,
            "process_id": m.process_id, "process_name": m.process_name,
            "physical_table": m.process.physical_table, "date_field": m.process.date_field,
            "agg_function": m.agg_function, "physical_field": m.physical_field,
            "data_type": m.data_type, "unit": m.unit, "status": m.status,
            "description": m.description,
            "derived_refs": [{"id": d.id, "code": d.code, "name": d.name,
                              "time_period": d.time_period} for d in derived],
        })
    finally:
        s.close()


@router.put("/atomic-metrics/{metric_id}", tags=["原子指标"])
def update_atomic(metric_id: int, body: AtomicIn):
    s = get_session()
    try:
        m = _get_or_404(s, AtomicMetric, metric_id, "原子指标")
        _check_code(s, AtomicMetric, body.code, exclude_id=metric_id)
        _get_or_404(s, BusinessProcess, body.process_id, "业务过程")
        if body.agg_function not in AGG_FUNCTIONS:
            raise HTTPException(400, f"非法聚合方式: {body.agg_function}")
        for k, v in body.dict().items():
            setattr(m, k, v)
        s.commit()
        return ok({"id": m.id})
    finally:
        s.close()


@router.delete("/atomic-metrics/{metric_id}", tags=["原子指标"])
def delete_atomic(metric_id: int):
    """删除校验：被派生指标引用则禁止删除"""
    s = get_session()
    try:
        m = _get_or_404(s, AtomicMetric, metric_id, "原子指标")
        n = s.query(DerivedMetric).filter_by(atomic_id=metric_id).count()
        if n:
            raise HTTPException(409, f"原子指标 {m.name} 被 {n} 个派生指标引用，禁止删除")
        s.delete(m)
        s.commit()
        return ok({"deleted": metric_id})
    finally:
        s.close()


@router.post("/atomic-metrics/{metric_id}/status", tags=["原子指标"])
def change_atomic_status(metric_id: int, body: StatusIn):
    """发布/归档原子指标（状态变更）"""
    s = get_session()
    try:
        m = _get_or_404(s, AtomicMetric, metric_id, "原子指标")
        _check_status_arg(body.status)
        m.status = body.status
        s.commit()
        return ok({"id": m.id, "code": m.code, "status": m.status})
    finally:
        s.close()


# ===========================================================================
# 5.4 维度管理（含维度属性）
# ===========================================================================

@router.post("/dimensions", tags=["维度"])
def create_dimension(body: DimensionIn):
    s = get_session()
    try:
        _check_code(s, Dimension, body.code)
        _get_or_404(s, SubjectDomain, body.domain_id, "主题域")
        d = Dimension(**body.dict())
        s.add(d)
        s.commit()
        return ok({"id": d.id, "code": d.code})
    finally:
        s.close()


@router.get("/dimensions", tags=["维度"])
def list_dimensions(domain_id: Optional[int] = None, keyword: str = ""):
    s = get_session()
    try:
        q = s.query(Dimension)
        if domain_id:
            q = q.filter_by(domain_id=domain_id)
        if keyword:
            q = q.filter(or_(Dimension.code.like(f"%{keyword}%"),
                             Dimension.name.like(f"%{keyword}%")))
        items = [{
            "id": d.id, "code": d.code, "name": d.name,
            "domain_id": d.domain_id, "domain_name": d.domain_name,
            "physical_table": d.physical_table,
            "join_field": d.join_field, "name_field": d.name_field,
            "description": d.description,
            "attributes": [{"id": a.id, "code": a.code, "name": a.name,
                            "physical_field": a.physical_field,
                            "data_type": a.data_type}
                           for a in d.attributes],
        } for d in q.order_by(Dimension.id).all()]
        return ok(items)
    finally:
        s.close()


@router.get("/dimensions/{dim_id}", tags=["维度"])
def get_dimension(dim_id: int):
    """详情含维度属性列表 + 使用该维度的派生指标"""
    s = get_session()
    try:
        d = _get_or_404(s, Dimension, dim_id, "维度")
        return ok({
            "id": d.id, "code": d.code, "name": d.name,
            "domain_id": d.domain_id, "domain_name": d.domain_name,
            "physical_table": d.physical_table,
            "join_field": d.join_field, "name_field": d.name_field,
            "description": d.description,
            "attributes": [{"id": a.id, "code": a.code, "name": a.name,
                            "physical_field": a.physical_field,
                            "data_type": a.data_type}
                           for a in d.attributes],
            "used_by": [{"code": dm.code, "name": dm.name}
                        for dm in s.query(DerivedMetric).all()
                        if d.code in (dm.dim_codes or [])],
        })
    finally:
        s.close()


@router.put("/dimensions/{dim_id}", tags=["维度"])
def update_dimension(dim_id: int, body: DimensionIn):
    s = get_session()
    try:
        d = _get_or_404(s, Dimension, dim_id, "维度")
        _check_code(s, Dimension, body.code, exclude_id=dim_id)
        _get_or_404(s, SubjectDomain, body.domain_id, "主题域")
        for k, v in body.dict().items():
            setattr(d, k, v)
        s.commit()
        return ok({"id": d.id})
    finally:
        s.close()


@router.delete("/dimensions/{dim_id}", tags=["维度"])
def delete_dimension(dim_id: int):
    """删除校验：被派生指标引用则拒绝删除"""
    s = get_session()
    try:
        d = _get_or_404(s, Dimension, dim_id, "维度")
        using = [dm.code for dm in s.query(DerivedMetric).all()
                 if d.code in (dm.dim_codes or [])]
        if using:
            raise HTTPException(409, f"维度 {d.name} 被派生指标引用: {', '.join(using)}，禁止删除")
        s.delete(d)
        s.commit()
        return ok({"deleted": dim_id})
    finally:
        s.close()


# ---- 维度属性 ----

@router.post("/dimensions/{dim_id}/attributes", tags=["维度属性"])
def add_attribute(dim_id: int, body: AttrIn):
    s = get_session()
    try:
        d = _get_or_404(s, Dimension, dim_id, "维度")
        if any(a.code == body.code for a in d.attributes):
            raise HTTPException(409, f"属性编码已存在: {body.code}")
        a = DimensionAttribute(dimension_id=dim_id, **body.dict())
        s.add(a)
        s.commit()
        return ok({"id": a.id, "code": a.code})
    finally:
        s.close()


@router.put("/dimension-attributes/{attr_id}", tags=["维度属性"])
def update_attribute(attr_id: int, body: AttrIn):
    s = get_session()
    try:
        a = _get_or_404(s, DimensionAttribute, attr_id, "维度属性")
        for k, v in body.dict().items():
            setattr(a, k, v)
        s.commit()
        return ok({"id": a.id})
    finally:
        s.close()


@router.delete("/dimension-attributes/{attr_id}", tags=["维度属性"])
def delete_attribute(attr_id: int):
    s = get_session()
    try:
        a = _get_or_404(s, DimensionAttribute, attr_id, "维度属性")
        s.delete(a)
        s.commit()
        return ok({"deleted": attr_id})
    finally:
        s.close()


# ===========================================================================
# 5.5 派生指标管理（P0 派生规则引擎）
# ===========================================================================

@router.post("/derived-metrics", tags=["派生指标"])
def create_derived(body: DerivedIn):
    """派生指标 = 原子指标 + 时间周期 + 统计粒度 + 业务限定（修饰词）"""
    s = get_session()
    try:
        _check_code(s, DerivedMetric, body.code)
        atomic = s.query(AtomicMetric).filter_by(code=body.atomic_code).first()
        if not atomic:
            raise HTTPException(404, f"原子指标不存在: {body.atomic_code}")
        if body.time_period not in TIME_PERIODS:
            raise HTTPException(400, f"非法时间周期: {body.time_period}，可选 {TIME_PERIODS}")
        _check_filters(s, body.filters)
        _check_dims(s, body.dim_codes)
        m = DerivedMetric(code=body.code, name=body.name, atomic_id=atomic.id,
                          time_period=body.time_period, dim_codes=body.dim_codes,
                          filters=body.filters, status=body.status,
                          description=body.description)
        s.add(m)
        s.commit()
        return ok({"id": m.id, "code": m.code})
    finally:
        s.close()


@router.get("/derived-metrics", tags=["派生指标"])
def list_derived(atomic_id: Optional[int] = None, keyword: str = "",
                 page: int = 1, page_size: int = 20):
    s = get_session()
    try:
        q = s.query(DerivedMetric)
        if atomic_id:
            q = q.filter_by(atomic_id=atomic_id)
        if keyword:
            q = q.filter(or_(DerivedMetric.code.like(f"%{keyword}%"),
                             DerivedMetric.name.like(f"%{keyword}%")))
        total = q.count()
        rows = (q.order_by(DerivedMetric.id)
                .offset((page - 1) * page_size).limit(page_size).all())
        items = [{
            "id": m.id, "code": m.code, "name": m.name,
            "atomic_id": m.atomic_id, "atomic_code": m.atomic.code,
            "atomic_name": m.atomic.name,
            "time_period": m.time_period, "dim_codes": m.dim_codes or [],
            "filters": m.filters or [], "status": m.status,
            "description": m.description,
        } for m in rows]
        return ok({"items": items, "total": total, "page": page, "page_size": page_size})
    finally:
        s.close()


@router.get("/derived-metrics/{metric_id}", tags=["派生指标"])
def get_derived(metric_id: int):
    """详情：原子信息 + 维度信息 + 动态生成 SQL（用户故事：查看生成的 SQL）"""
    s = get_session()
    try:
        m = _get_or_404(s, DerivedMetric, metric_id, "派生指标")
        dims = []
        for code in (m.dim_codes or []):
            d = s.query(Dimension).filter_by(code=code).first()
            if d:
                dims.append({"code": d.code, "name": d.name})
        refs = [{"code": c.code, "name": c.name}
                for c in s.query(CompositeMetric).all() if m.code in (c.ref_codes or [])]
        _type, sql, params = _metric_sql(m.code)
        return ok({
            "id": m.id, "code": m.code, "name": m.name,
            "atomic": {"code": m.atomic.code, "name": m.atomic.name,
                       "agg_function": m.atomic.agg_function,
                       "physical_field": m.atomic.physical_field,
                       "table": m.atomic.process.physical_table,
                       "date_field": m.atomic.process.date_field,
                       "unit": m.atomic.unit},
            "time_period": m.time_period, "dims": dims,
            "filters": m.filters or [], "status": m.status,
            "description": m.description, "composite_refs": refs,
            "generated_sql": sql, "sql_params": params,
        })
    finally:
        s.close()


@router.get("/derived-metrics/{metric_id}/sql-preview", tags=["派生指标"])
def derived_sql_preview(metric_id: int):
    """预览派生指标自动生成的 SQL（口径透明可审计）"""
    s = get_session()
    try:
        m = _get_or_404(s, DerivedMetric, metric_id, "派生指标")
        _type, sql, params = _metric_sql(m.code)
        return ok({"metric_code": m.code, "metric_name": m.name, "type": _type,
                   "sql": sql, "params": params})
    finally:
        s.close()


@router.put("/derived-metrics/{metric_id}", tags=["派生指标"])
def update_derived(metric_id: int, body: DerivedIn):
    s = get_session()
    try:
        m = _get_or_404(s, DerivedMetric, metric_id, "派生指标")
        _check_code(s, DerivedMetric, body.code, exclude_id=metric_id)
        atomic = s.query(AtomicMetric).filter_by(code=body.atomic_code).first()
        if not atomic:
            raise HTTPException(404, f"原子指标不存在: {body.atomic_code}")
        if body.time_period not in TIME_PERIODS:
            raise HTTPException(400, f"非法时间周期: {body.time_period}")
        _check_filters(s, body.filters)
        _check_dims(s, body.dim_codes)
        m.atomic_id = atomic.id
        for k in ("code", "name", "time_period", "dim_codes", "filters",
                  "status", "description"):
            setattr(m, k, body.dict()[k])
        s.commit()
        return ok({"id": m.id})
    finally:
        s.close()


@router.delete("/derived-metrics/{metric_id}", tags=["派生指标"])
def delete_derived(metric_id: int):
    """删除校验：被复合指标引用则拒绝删除"""
    s = get_session()
    try:
        m = _get_or_404(s, DerivedMetric, metric_id, "派生指标")
        using = [c.code for c in s.query(CompositeMetric).all()
                 if m.code in (c.ref_codes or [])]
        if using:
            raise HTTPException(409, f"派生指标 {m.name} 被复合指标引用: {', '.join(using)}，禁止删除")
        s.delete(m)
        s.commit()
        return ok({"deleted": metric_id})
    finally:
        s.close()


# ===========================================================================
# 5.6 复合指标管理
# ===========================================================================

def _check_refs(s, ref_codes: list):
    if not ref_codes:
        raise HTTPException(400, "复合指标必须引用至少一个派生指标")
    for rc in ref_codes:
        if not s.query(DerivedMetric).filter_by(code=rc).first():
            raise HTTPException(400, f"引用的派生指标不存在: {rc}")


@router.post("/composite-metrics", tags=["复合指标"])
def create_composite(body: CompositeIn):
    s = get_session()
    try:
        _check_code(s, CompositeMetric, body.code)
        _check_refs(s, body.ref_codes)
        for ref in body.ref_codes:
            if ref not in body.expression:
                raise HTTPException(400, f"计算表达式未引用指标 {ref}")
        m = CompositeMetric(**body.dict())
        s.add(m)
        s.commit()
        return ok({"id": m.id, "code": m.code})
    finally:
        s.close()


@router.get("/composite-metrics", tags=["复合指标"])
def list_composites(keyword: str = "", page: int = 1, page_size: int = 20):
    s = get_session()
    try:
        q = s.query(CompositeMetric)
        if keyword:
            q = q.filter(or_(CompositeMetric.code.like(f"%{keyword}%"),
                             CompositeMetric.name.like(f"%{keyword}%")))
        total = q.count()
        rows = (q.order_by(CompositeMetric.id)
                .offset((page - 1) * page_size).limit(page_size).all())
        items = [{
            "id": m.id, "code": m.code, "name": m.name,
            "expression": m.expression, "ref_codes": m.ref_codes or [],
            "data_type": m.data_type, "unit": m.unit, "status": m.status,
            "description": m.description,
        } for m in rows]
        return ok({"items": items, "total": total, "page": page, "page_size": page_size})
    finally:
        s.close()


@router.get("/composite-metrics/{metric_id}", tags=["复合指标"])
def get_composite(metric_id: int):
    """详情含引用的派生指标信息、计算表达式与生成 SQL"""
    s = get_session()
    try:
        m = _get_or_404(s, CompositeMetric, metric_id, "复合指标")
        refs = []
        for code in (m.ref_codes or []):
            dm = s.query(DerivedMetric).filter_by(code=code).first()
            if dm:
                refs.append({"code": dm.code, "name": dm.name,
                             "atomic_code": dm.atomic.code,
                             "time_period": dm.time_period})
        _type, sql, params = _metric_sql(m.code)
        return ok({
            "id": m.id, "code": m.code, "name": m.name,
            "expression": m.expression, "ref_codes": m.ref_codes or [],
            "refs": refs,
            "data_type": m.data_type, "unit": m.unit, "status": m.status,
            "description": m.description,
            "generated_sql": sql, "sql_params": params,
        })
    finally:
        s.close()


@router.get("/composite-metrics/{metric_id}/sql-preview", tags=["复合指标"])
def composite_sql_preview(metric_id: int):
    s = get_session()
    try:
        m = _get_or_404(s, CompositeMetric, metric_id, "复合指标")
        _type, sql, params = _metric_sql(m.code)
        return ok({"metric_code": m.code, "metric_name": m.name,
                   "type": _type, "sql": sql, "params": params})
    finally:
        s.close()


@router.put("/composite-metrics/{metric_id}", tags=["复合指标"])
def update_composite(metric_id: int, body: CompositeIn):
    s = get_session()
    try:
        m = _get_or_404(s, CompositeMetric, metric_id, "复合指标")
        _check_code(s, CompositeMetric, body.code, exclude_id=metric_id)
        _check_refs(s, body.ref_codes)
        for k, v in body.dict().items():
            setattr(m, k, v)
        s.commit()
        return ok({"id": m.id})
    finally:
        s.close()


@router.delete("/composite-metrics/{metric_id}", tags=["复合指标"])
def delete_composite(metric_id: int):
    s = get_session()
    try:
        m = _get_or_404(s, CompositeMetric, metric_id, "复合指标")
        s.delete(m)
        s.commit()
        return ok({"deleted": metric_id})
    finally:
        s.close()


# ===========================================================================
# 5.7 统一指标查询（核心：动态 SQL 生成 + 执行）
# ===========================================================================

@router.post("/query", tags=["统一指标查询"])
def query(body: QueryRequest):
    codes = body.metric_codes or ([body.metric_code] if body.metric_code else None)
    if not codes:
        raise HTTPException(400, "必须指定指标（metric_codes 或 metric_code）")
    if body.granularity not in GRANULARITY_FMT:
        raise HTTPException(400, f"不支持的日期粒度: {body.granularity}")
    try:
        meta, cols, rows, sql = gen.execute_multi(
            codes, body.dim_codes, body.start_date, body.end_date, body.granularity)
    except MetricNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))

    # 指标值列：跳过首列 date_bucket 与维度列，其余均为指标列
    n_dims = len(body.dim_codes)
    value_idx = [i for i in range(1 + n_dims, len(cols))]
    values = [r[i] for r in rows for i in value_idx
              if isinstance(r[i], (int, float))]
    summary = {
        "metric_names": meta["metric_names"], "metric_types": meta["metric_types"],
        "granularity": meta["granularity"], "row_count": len(rows),
        "total": round(sum(values), 2) if values else None,
        "avg": round(sum(values) / len(values), 2) if values else None,
    }
    return ok({"summary": summary, "columns": cols, "rows": rows, "sql": sql})


@router.get("/sql-preview", tags=["指标查询"])
def sql_preview(metric_codes: str, dim_codes: str = "",
                start_date: Optional[str] = None, end_date: Optional[str] = None,
                granularity: str = "day"):
    """只生成 SQL 不执行（口径透明：任何查询可查看生成逻辑）"""
    codes = [c for c in metric_codes.split(",") if c]
    dims = [d for d in dim_codes.split(",") if d] if dim_codes else []
    if not codes:
        raise HTTPException(400, "metric_codes 不能为空")
    if granularity not in GRANULARITY_FMT:
        raise HTTPException(400, f"不支持的日期粒度: {granularity}")
    try:
        mtypes, mnames, sql, params = gen.generate_multi(
            codes, dims, start_date, end_date, granularity)
    except (MetricNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e))
    return ok({"metric_codes": codes, "metric_names": mnames,
               "metric_types": mtypes, "granularity": granularity,
               "sql": sql, "params": params})


def _export_excel(cols, rows, title="指标查询结果"):
    """查询结果导出 Excel（openpyxl 生成 .xlsx）"""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]
    ws.append(cols)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="2F54EB")
    for r in rows:
        ws.append(r)
    for col_cells in ws.columns:
        width = max((len(str(c.value)) for c in col_cells if c.value is not None), default=8)
        ws.column_dimensions[col_cells[0].column_letter].width = min(width * 1.9 + 4, 42)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


@router.get("/query/export", tags=["指标查询"])
def export_query(metric_codes: str, dim_codes: str = "",
                 start_date: Optional[str] = None, end_date: Optional[str] = None,
                 granularity: str = "day"):
    """导出查询结果为 Excel（.xlsx 下载）"""
    codes = [c for c in metric_codes.split(",") if c]
    dims = [d for d in dim_codes.split(",") if d] if dim_codes else []
    if not codes:
        raise HTTPException(400, "metric_codes 不能为空")
    try:
        _meta, cols, rows, _sql = gen.execute_multi(
            codes, dims, start_date, end_date, granularity)
    except (MetricNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e))
    buf = _export_excel(cols, rows, "指标查询")
    filename = f"metric_{codes[0]}_multi.xlsx"
    return StreamingResponse(
        buf,
        media_type=("application/vnd.openxmlformats-officedocument"
                    ".spreadsheetml.sheet"),
        headers={"Content-Disposition": f"attachment; filename={filename}"})


# ===========================================================================
# 5.8 逻辑模型管理（P1：物理表 -> 逻辑模型，屏蔽底层差异）
# ===========================================================================

def _logical_model_sql(m: LogicalModel) -> str:
    return gen.logical_model_sql(m)


@router.post("/logical-models", tags=["逻辑模型"])
def create_logical_model(body: LogicalModelIn):
    s = get_session()
    try:
        _check_code(s, LogicalModel, body.code)
        _get_or_404(s, SubjectDomain, body.domain_id, "主题域")
        m = LogicalModel(**body.dict())
        s.add(m)
        s.commit()
        return ok({"id": m.id, "code": m.code})
    finally:
        s.close()


@router.get("/logical-models", tags=["逻辑模型"])
def list_logical_models(keyword: str = ""):
    s = get_session()
    try:
        q = s.query(LogicalModel)
        if keyword:
            q = q.filter(or_(LogicalModel.code.like(f"%{keyword}%"),
                             LogicalModel.name.like(f"%{keyword}%")))
        items = [{
            "id": m.id, "code": m.code, "name": m.name,
            "domain_id": m.domain_id, "domain_name": m.domain_name,
            "physical_table": m.physical_table, "join_type": m.join_type,
            "join_config": m.join_config or [], "description": m.description,
            "generated_sql": _logical_model_sql(m),
        } for m in q.order_by(LogicalModel.id).all()]
        return ok(items)
    finally:
        s.close()


@router.get("/logical-models/{model_id}", tags=["逻辑模型"])
def get_logical_model(model_id: int):
    s = get_session()
    try:
        m = _get_or_404(s, LogicalModel, model_id, "逻辑模型")
        return ok({
            "id": m.id, "code": m.code, "name": m.name,
            "domain_id": m.domain_id, "domain_name": m.domain_name,
            "physical_table": m.physical_table, "join_type": m.join_type,
            "join_config": m.join_config or [], "description": m.description,
            "generated_sql": _logical_model_sql(m),
        })
    finally:
        s.close()


@router.put("/logical-models/{model_id}", tags=["逻辑模型"])
def update_logical_model(model_id: int, body: LogicalModelIn):
    s = get_session()
    try:
        m = _get_or_404(s, LogicalModel, model_id, "逻辑模型")
        _check_code(s, LogicalModel, body.code, exclude_id=model_id)
        _get_or_404(s, SubjectDomain, body.domain_id, "主题域")
        for k, v in body.dict().items():
            setattr(m, k, v)
        s.commit()
        return ok({"id": m.id})
    finally:
        s.close()


@router.delete("/logical-models/{model_id}", tags=["逻辑模型"])
def delete_logical_model(model_id: int):
    s = get_session()
    try:
        m = _get_or_404(s, LogicalModel, model_id, "逻辑模型")
        s.delete(m)
        s.commit()
        return ok({"deleted": model_id})
    finally:
        s.close()


# ===========================================================================
# 5.9 下游模型管理：基于逻辑模型 + 指标集合生成指标汇总模型，支持物化
# 定义 SQL 生成见 SQLGenerator.generate_downstream_sql（sql_generator.py）
# ===========================================================================

class DownstreamIn(BaseModel):
    code: str
    name: str
    source_model_id: int
    metrics: list
    granularity: str = "day"
    description: str = ""


@router.post("/downstream-models", tags=["下游模型"])
def create_downstream(body: DownstreamIn):
    s = get_session()
    try:
        _check_code(s, DownstreamModel, body.code)
        lm = _get_or_404(s, LogicalModel, body.source_model_id, "逻辑模型")
        m = DownstreamModel(**body.dict())
        try:
            sql, params = gen.generate_downstream_sql(m, lm)
            m.definition_sql = sql
        except ValueError as e:
            raise HTTPException(400, str(e))
        s.add(m)
        s.commit()
        return ok({"id": m.id, "definition_sql": m.definition_sql,
                   "params": params})
    finally:
        s.close()


@router.get("/downstream-models", tags=["下游模型"])
def list_downstream(page: int = 1, page_size: int = 20, keyword: str = ""):
    s = get_session()
    try:
        q = s.query(DownstreamModel).order_by(DownstreamModel.id.desc())
        if keyword:
            like = f"%{keyword}%"
            q = q.filter(or_(DownstreamModel.code.like(like),
                             DownstreamModel.name.like(like)))
        total = q.count()
        rows = q.offset((page - 1) * page_size).limit(page_size).all()
        items = [{
            "id": m.id, "code": m.code, "name": m.name,
            "source_model_id": m.source_model_id,
            "source_model_name": m.source_model_name,
            "metrics": m.metrics or [], "granularity": m.granularity,
            "materialized": bool(m.materialized),
            "physical_table": m.physical_table, "row_count": m.row_count,
            "description": m.description,
        } for m in rows]
        return ok({"total": total, "page": page, "page_size": page_size,
                   "items": items})
    finally:
        s.close()


@router.get("/downstream-models/{model_id}", tags=["下游模型"])
def get_downstream(model_id: int):
    s = get_session()
    try:
        m = _get_or_404(s, DownstreamModel, model_id, "下游模型")
        return ok({
            "id": m.id, "code": m.code, "name": m.name,
            "source_model_id": m.source_model_id,
            "source_model_name": m.source_model_name,
            "metrics": m.metrics or [], "granularity": m.granularity,
            "definition_sql": m.definition_sql,
            "materialized": bool(m.materialized),
            "physical_table": m.physical_table, "row_count": m.row_count,
            "description": m.description,
        })
    finally:
        s.close()


@router.put("/downstream-models/{model_id}", tags=["下游模型"])
def update_downstream(model_id: int, body: DownstreamIn):
    s = get_session()
    try:
        m = _get_or_404(s, DownstreamModel, model_id, "下游模型")
        _check_code(s, DownstreamModel, body.code, exclude_id=model_id)
        lm = _get_or_404(s, LogicalModel, body.source_model_id, "逻辑模型")
        for k, v in body.dict().items():
            setattr(m, k, v)
        try:
            sql, _ = gen.generate_downstream_sql(m, lm)
            m.definition_sql = sql
        except ValueError as e:
            raise HTTPException(400, str(e))
        # 定义变更后旧物化表过期：落地表删除并复位状态
        if m.materialized and m.physical_table:
            tbl = _safe_ident(m.physical_table)
            with engine.begin() as conn:
                conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))
            m.materialized = 0
            m.physical_table = None
            m.row_count = None
        s.commit()
        return ok({"id": m.id})
    finally:
        s.close()


@router.delete("/downstream-models/{model_id}", tags=["下游模型"])
def delete_downstream(model_id: int):
    s = get_session()
    try:
        m = _get_or_404(s, DownstreamModel, model_id, "下游模型")
        if m.materialized and m.physical_table:
            tbl = _safe_ident(m.physical_table)
            with engine.begin() as conn:
                conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))
        s.delete(m)
        s.commit()
        return ok({"deleted": model_id})
    finally:
        s.close()


@router.post("/downstream-models/{model_id}/materialize", tags=["下游模型"])
def materialize_downstream(model_id: int):
    """物化：CREATE TABLE dl_{code} AS <定义 SQL>；重复执行 = 重建刷新（幂等）"""
    s = get_session()
    try:
        m = _get_or_404(s, DownstreamModel, model_id, "下游模型")
        try:
            sql, params = gen.generate_downstream_sql(m)
        except ValueError as e:
            raise HTTPException(400, str(e))
        tbl = f"dl_{_safe_ident(m.code)}"
        m.definition_sql = sql
        with engine.begin() as conn:
            conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))
            conn.execute(text(f"CREATE TABLE {tbl} AS {sql}"), params)
        n = engine.connect().execute(
            text(f"SELECT COUNT(*) FROM {tbl}")).scalar()
        m.materialized = 1
        m.physical_table = tbl
        m.row_count = n
        s.commit()
        return ok({"physical_table": tbl, "row_count": n})
    finally:
        s.close()


@router.post("/downstream-models/{model_id}/preview", tags=["下游模型"])
def preview_downstream(model_id: int, limit: int = 100):
    """执行定义 SQL 预览（不落地），返回前 limit 行"""
    s = get_session()
    try:
        m = _get_or_404(s, DownstreamModel, model_id, "下游模型")
        try:
            sql, params = gen.generate_downstream_sql(m)
        except ValueError as e:
            raise HTTPException(400, str(e))
        result = s.execute(text(sql), params)
        cols = list(result.keys())
        rows = [list(r) for r in result.fetchmany(limit)]
        return ok({"columns": cols, "rows": rows, "row_count": len(rows)})
    finally:
        s.close()


@router.get("/downstream-models/{model_id}/data", tags=["下游模型"])
def downstream_data(model_id: int, page: int = 1, page_size: int = 100):
    """查询物化表数据（分页）"""
    s = get_session()
    try:
        m = _get_or_404(s, DownstreamModel, model_id, "下游模型")
        if not m.materialized or not m.physical_table:
            raise HTTPException(400, "下游模型尚未物化，请先执行物化")
        tbl = _safe_ident(m.physical_table)
        total = s.execute(text(f"SELECT COUNT(*) FROM {tbl}")).scalar()
        rows_sql = text(
            f"SELECT * FROM {tbl} ORDER BY date_bucket "
            f"LIMIT {int(page_size)} OFFSET {(int(page) - 1) * int(page_size)}")
        result = s.execute(rows_sql)
        return ok({"total": total, "page": page, "page_size": page_size,
                   "columns": list(result.keys()),
                   "rows": [list(r) for r in result.fetchall()]})
    finally:
        s.close()


# ===========================================================================
# 血缘追溯（P2）：物理表/字段 -> 原子 -> 派生 -> 复合
# ===========================================================================

def _atomic_node(m: AtomicMetric):
    return {"id": f"atomic:{m.code}", "type": "atomic", "label": m.name, "code": m.code}


def _physical_nodes(a: AtomicMetric, nodes: list, edges: list):
    p = a.process
    nodes.append({"id": f"table:{p.physical_table}", "type": "table",
                  "label": p.physical_table, "code": p.physical_table})
    nodes.append({"id": f"field:{p.physical_table}.{a.physical_field}",
                  "type": "field", "label": a.physical_field,
                  "code": a.physical_field})
    edges.append({"from": f"field:{p.physical_table}.{a.physical_field}",
                  "to": f"atomic:{a.code}"})
    edges.append({"from": f"table:{p.physical_table}",
                  "to": f"field:{p.physical_table}.{a.physical_field}"})


def _lineage_upstream(s, code: str, nodes: list, edges: list, seen: set):
    """向上追溯（根因分析）：复合 <- 派生 <- 原子 <- 物理表/字段"""
    comp = s.query(CompositeMetric).filter_by(code=code).first()
    if comp:
        nodes.append({"id": f"composite:{code}", "type": "composite",
                      "label": comp.name, "code": code})
        for ref in comp.ref_codes or []:
            if ("composite", code, "derived", ref) in seen:
                continue
            seen.add(("composite", code, "derived", ref))
            dm = s.query(DerivedMetric).filter_by(code=ref).first()
            if dm:
                nodes.append({"id": f"derived:{ref}", "type": "derived",
                              "label": dm.name, "code": ref})
                edges.append({"from": f"derived:{ref}", "to": f"composite:{code}"})
                _lineage_upstream(s, ref, nodes, edges, seen)

    der = s.query(DerivedMetric).filter_by(code=code).first()
    if der:
        if not any(n["id"] == f"derived:{code}" for n in nodes):
            nodes.append({"id": f"derived:{code}", "type": "derived",
                          "label": der.name, "code": code})
        a = der.atomic
        nodes.append(_atomic_node(a))
        edges.append({"from": f"atomic:{a.code}", "to": f"derived:{code}"})
        _physical_nodes(a, nodes, edges)

    atom = s.query(AtomicMetric).filter_by(code=code).first()
    if atom:
        if not any(n["id"] == f"atomic:{code}" for n in nodes):
            nodes.append(_atomic_node(atom))
        _physical_nodes(atom, nodes, edges)


def _lineage_downstream(s, code: str, nodes: list, edges: list):
    """向下影响（影响分析）：原子/派生 -> 下游派生/复合"""
    has_atomic = bool(s.query(AtomicMetric).filter_by(code=code).first())
    for dm in s.query(DerivedMetric).all():
        if has_atomic and code == dm.atomic.code:
            if not any(n["id"] == f"derived:{dm.code}" for n in nodes):
                nodes.append({"id": f"derived:{dm.code}", "type": "derived",
                              "label": dm.name, "code": dm.code})
            edges.append({"from": f"atomic:{code}", "to": f"derived:{dm.code}"})
        elif code == dm.code and not any(n["id"] == f"derived:{dm.code}" for n in nodes):
            nodes.append({"id": f"derived:{dm.code}", "type": "derived",
                          "label": dm.name, "code": dm.code})
        for cm in s.query(CompositeMetric).all():
            if dm.code in (cm.ref_codes or []) and \
                    any(n["id"] == f"derived:{dm.code}" for n in nodes):
                if not any(n["id"] == f"composite:{cm.code}" for n in nodes):
                    nodes.append({"id": f"composite:{cm.code}", "type": "composite",
                                  "label": cm.name, "code": cm.code})
                edges.append({"from": f"derived:{dm.code}",
                              "to": f"composite:{cm.code}"})


@router.get("/lineage/tables", tags=["血缘"])
def lineage_tables():
    """表级血缘（全量）：物理表 -> 逻辑模型 -> 下游模型 -> 物化表
    逻辑模型的物理表关联由 physical_table + join_config 推导"""
    s = get_session()
    try:
        nodes, edges = [], []
        seen_tables = set()

        def add_table(tbl: str):
            if tbl and tbl not in seen_tables:
                seen_tables.add(tbl)
                nodes.append({"id": f"table:{tbl}", "type": "table",
                              "label": tbl, "code": tbl})

        # 指标口径涉及的物理表
        for p in s.query(BusinessProcess).all():
            add_table(p.physical_table)
        for d in s.query(Dimension).all():
            add_table(d.physical_table)

        # 逻辑模型：物理表 -> 模型（含 join_config 关联表）
        for lm in s.query(LogicalModel).all():
            nid = f"model:{lm.code}"
            nodes.append({"id": nid, "type": "logical_model",
                          "label": lm.name, "code": lm.code})
            add_table(lm.physical_table)
            edges.append({"from": f"table:{lm.physical_table}", "to": nid})
            for j in lm.join_config or []:
                tbl = j.get("table", "")
                add_table(tbl)
                edges.append({"from": f"table:{tbl}", "to": nid})

        # 下游模型：逻辑模型 -> 下游模型 -> 物化表
        for dm in s.query(DownstreamModel).all():
            nid = f"downstream:{dm.code}"
            nodes.append({"id": nid, "type": "downstream_model",
                          "label": dm.name, "code": dm.code})
            edges.append({"from": f"model:{dm.source_model.code}", "to": nid})
            if dm.materialized and dm.physical_table:
                add_table(dm.physical_table)
                edges.append({"from": nid, "to": f"table:{dm.physical_table}"})

        return ok({"nodes": nodes, "edges": edges})
    finally:
        s.close()


@router.get("/lineage/{code}", tags=["血缘"])
def get_lineage(code: str):
    """全链路血缘：物理表/字段 -> 原子 -> 派生 -> 复合（影响分析 + 根因追溯）"""
    s = get_session()
    try:
        nodes, edges = [], []
        _lineage_upstream(s, code, nodes, edges, set())
        if not nodes:
            raise HTTPException(404, f"指标不存在: {code}")
        _lineage_downstream(s, code, nodes, edges)

        seen_ids, uniq_nodes = set(), []
        for n in nodes:
            if n["id"] not in seen_ids:
                seen_ids.add(n["id"])
                uniq_nodes.append(n)
        uniq_edges, seen_e = [], set()
        for e in edges:
            k = (e["from"], e["to"])
            if k not in seen_e:
                seen_e.add(k)
                uniq_edges.append(e)
        return ok({"nodes": uniq_nodes, "edges": uniq_edges})
    finally:
        s.close()


# ===========================================================================
# 元数据浏览（Dashboard 用）+ 静态资源
# ===========================================================================

@router.get("/overview", tags=["概览"])
def overview():
    s = get_session()
    try:
        return ok({
            "domains": s.query(SubjectDomain).count(),
            "processes": s.query(BusinessProcess).count(),
            "dimensions": s.query(Dimension).count(),
            "atomic": s.query(AtomicMetric).count(),
            "derived": s.query(DerivedMetric).count(),
            "composite": s.query(CompositeMetric).count(),
            "logical_models": s.query(LogicalModel).count(),
            "downstream_models": s.query(DownstreamModel).count(),
        })
    finally:
        s.close()


@router.get("/metrics", tags=["概览"])
def list_metrics():
    """全部指标元数据（按类型分组），供前端筛选展示"""
    s = get_session()
    try:
        atomic = [{"type": "atomic", "id": m.id, "code": m.code, "name": m.name,
                   "process": m.process.name, "agg": m.agg_function,
                   "field": m.physical_field, "table": m.process.physical_table,
                   "unit": m.unit, "status": m.status, "description": m.description}
                  for m in s.query(AtomicMetric).all()]
        derived = [{"type": "derived", "id": m.id, "code": m.code, "name": m.name,
                    "atomic": m.atomic.code, "time_period": m.time_period,
                    "dim_codes": m.dim_codes or [], "filters": m.filters or [],
                    "unit": m.atomic.unit, "status": m.status,
                    "description": m.description}
                   for m in s.query(DerivedMetric).all()]
        composite = [{"type": "composite", "id": m.id, "code": m.code, "name": m.name,
                      "expression": m.expression, "ref_codes": m.ref_codes or [],
                      "unit": m.unit, "status": m.status, "description": m.description}
                     for m in s.query(CompositeMetric).all()]
        return ok({"atomic": atomic, "derived": derived, "composite": composite})
    finally:
        s.close()


# ===========================================================================
# App 组装：统一响应包装 + 双前缀挂载（/api 与 /api/v1）
# ===========================================================================

app = FastAPI(title="统一指标维度管理平台 Demo", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])


@app.exception_handler(HTTPException)
async def http_exc_handler(request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code or 400,
        content={"code": exc.status_code or 400, "message": str(exc.detail),
                 "data": None})


@app.exception_handler(Exception)
async def unhandled_exc_handler(request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"code": 500, "message": f"服务器错误: {exc}", "data": None})


app.include_router(router, prefix="/api")
app.include_router(router, prefix="/api/v1")


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)