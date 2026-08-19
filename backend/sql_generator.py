"""SQL 动态生成器（逻辑层核心）

Dataphin 模式：查询时根据元数据动态拼装 SQL，不预生成视图。
流程：指标编码 -> 查元数据 -> 取计算公式/维度映射/物理映射 -> 拼装 SQL
"""
import datetime as dt

from sqlalchemy import text
from sqlalchemy.orm import joinedload

from models import get_session, AtomicMetric, DerivedMetric, CompositeMetric, Dimension

# SQLite 安全白名单校验
import re

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_ident(name: str) -> str:
    if not _IDENT_RE.match(name or ""):
        raise ValueError(f"非法标识符: {name!r}")
    return name


class MetricNotFoundError(Exception):
    pass


class SQLGenerator:
    """元数据驱动的 SQL 生成器"""

    # ------------------------------------------------------------------
    # 元数据解析
    # ------------------------------------------------------------------

    @staticmethod
    def find_metric(code: str):
        """按编码定位指标，返回 (type, 实体)；关联关系预加载避免会话分离"""
        s = get_session()
        try:
            m = (s.query(AtomicMetric)
                 .options(joinedload(AtomicMetric.process))
                 .filter_by(code=code).first())
            if m:
                return "atomic", m
            m = (s.query(DerivedMetric)
                 .options(joinedload(DerivedMetric.atomic).joinedload(AtomicMetric.process))
                 .filter_by(code=code).first())
            if m:
                return "derived", m
            m = s.query(CompositeMetric).filter_by(code=code).first()
            if m:
                return "composite", m
            raise MetricNotFoundError(f"指标不存在: {code}")
        finally:
            s.close()

    @staticmethod
    def resolve_period(period: str, start_date=None, end_date=None):
        """时间周期编码 -> 具体 [start, end] 日期"""
        today = dt.date.today()
        end = dt.date.fromisoformat(end_date) if end_date else today
        mapping = {
            "1d": 1, "7d": 7, "30d": 30, "90d": 90,
        }
        if period == "custom":
            if not start_date:
                raise ValueError("custom 周期必须传 start_date")
            return dt.date.fromisoformat(start_date), end
        if period == "ytd":
            return dt.date(end.year, 1, 1), end
        if period in mapping:
            return end - dt.timedelta(days=mapping[period]), end
        raise ValueError(f"未知时间周期: {period}")

    @staticmethod
    def resolve_dimension(dim_code: str):
        """维度编码 -> 维度元数据"""
        s = get_session()
        try:
            d = s.query(Dimension).filter_by(code=dim_code).first()
            if not d:
                raise ValueError(f"维度不存在: {dim_code}")
            return d
        finally:
            s.close()

    # ------------------------------------------------------------------
    # SQL 构建
    # ------------------------------------------------------------------

    def build_atomic_sql(self, metric: AtomicMetric, dim_codes, start, end,
                         filters=None, prefix=""):
        """原子指标 SQL：AGG(物理字段) FROM 事实表 JOIN 维度表
        prefix 用于复合指标子查询参数键去重"""
        table = _safe_ident(metric.process.physical_table)
        date_field = _safe_ident(metric.process.date_field)
        agg = _safe_ident(metric.agg_function)
        field = _safe_ident(metric.physical_field)

        select_cols, join_clauses, group_cols, where_params = [], [], [], {}

        for dc in dim_codes:
            dim = self.resolve_dimension(dc)
            dt_ = _safe_ident(dim.physical_table)
            jf = _safe_ident(dim.join_field)
            nf = _safe_ident(dim.name_field)
            alias = f"d{len(join_clauses)}"
            select_cols.append(f"{alias}.{nf} AS {dc}")
            group_cols.append(f"{alias}.{nf}")
            join_clauses.append(f"LEFT JOIN {dt_} {alias} ON t.{jf} = {alias}.{jf}")

        where_clauses = [f"t.{date_field} >= :{prefix}_start",
                         f"t.{date_field} <= :{prefix}_end"]
        where_params[f"{prefix}_start"] = start.isoformat()
        where_params[f"{prefix}_end"] = end.isoformat()

        for f in (filters or []):
            fld = _safe_ident(f["field"])
            op = f["op"]
            if op not in ("=", "!=", ">", "<", ">=", "<=", "IN", "LIKE"):
                raise ValueError(f"不支持的操作符: {op}")
            key = f"{prefix}_f{len(where_params)}"
            if op == "IN":
                vals = f["value"] if isinstance(f["value"], list) else [f["value"]]
                ph = ", ".join([f":{key}_{i}" for i in range(len(vals))])
                where_clauses.append(f"t.{fld} {op} ({ph})")
                for i, v in enumerate(vals):
                    where_params[f"{key}_{i}"] = v
            else:
                where_clauses.append(f"t.{fld} {op} :{key}")
                where_params[key] = f["value"]

        dims_part = (", " + ", ".join(select_cols)) if select_cols else ""
        group_part = (" GROUP BY " + ", ".join(group_cols)) if group_cols else ""
        join_part = (" " + " ".join(join_clauses)) if join_clauses else ""

        sql = (
            f"SELECT {agg}(t.{field}) AS metric_value{dims_part}\n"
            f"FROM {table} t{join_part}\n"
            f"WHERE {' AND '.join(where_clauses)}{group_part}"
        )
        return sql, where_params

    def build_derived_sql(self, metric: DerivedMetric, dim_codes=None,
                          start_date=None, end_date=None, prefix=""):
        """派生指标 SQL：原子指标 + 时间周期 + 统计维度 + 业务限定"""
        use_dims = dim_codes if dim_codes is not None else (metric.dim_codes or [])
        start, end = self.resolve_period(metric.time_period, start_date, end_date)
        filters = list(metric.filters or [])
        return self.build_atomic_sql(metric.atomic, use_dims, start, end, filters, prefix)

    def build_composite_sql(self, metric: CompositeMetric, dim_codes=None,
                            start_date=None, end_date=None):
        """复合指标 SQL：各派生指标生成子查询，按维度 JOIN 后套表达式"""
        if not metric.ref_codes:
            raise ValueError(f"复合指标 {metric.code} 未配置引用指标")
        s = get_session()
        try:
            derived_list = []
            for ref in metric.ref_codes:
                dm = (s.query(DerivedMetric)
                      .options(joinedload(DerivedMetric.atomic).joinedload(AtomicMetric.process))
                      .filter_by(code=ref).first())
                if not dm:
                    raise ValueError(f"引用的派生指标不存在: {ref}")
                derived_list.append(dm)
        finally:
            s.close()

        # 有效维度：显式传入优先，否则取首个被引用派生指标的统计维度
        eff_dims = dim_codes if dim_codes is not None else (derived_list[0].dim_codes or [])
        has_dims = bool(eff_dims)

        subs, merged_params = [], {}
        for i, dm in enumerate(derived_list):
            sub_sql, sub_params = self.build_derived_sql(
                dm, eff_dims, start_date, end_date, prefix=f"s{i}")
            merged_params.update(sub_params)
            subs.append((f"t{i}", dm.code, sub_sql))

        select_expr = metric.expression
        for alias, ref, _ in subs:
            select_expr = select_expr.replace(ref, f"{alias}.metric_value")
        # 防止除零
        if "/" in select_expr:
            import re as _re
            select_expr = _re.sub(r"(\S+)\s*/\s*(\S+\.metric_value)",
                                  r"CAST(\1 AS REAL) / NULLIF(\2, 0)", select_expr)

        if not has_dims or len(subs) == 1:
            sql = f"SELECT {select_expr} AS metric_value\nFROM (\n{subs[0][2]}\n) t0"
            for alias, ref, sub_sql in subs[1:]:
                sql += f"\nCROSS JOIN (\n{sub_sql}\n) {alias}"
            return sql, merged_params

        # 带维度：按维度列 JOIN 各子查询（列顺序与原子/派生一致：metric_value 在前）
        on_parts = " AND ".join(f"t0.{d} = {alias}.{d}"
                                for alias, _, _ in subs[1:] for d in eff_dims)
        dim_select = ", ".join(f"t0.{dc}" for dc in eff_dims)
        sql = (
            f"SELECT {select_expr} AS metric_value, {dim_select}\n"
            f"FROM (\n{subs[0][2]}\n) t0\n"
        )
        for alias, ref, sub_sql in subs[1:]:
            sql += f"JOIN (\n{sub_sql}\n) {alias} ON {on_parts}\n"
        return sql.rstrip("\n"), merged_params

    # ------------------------------------------------------------------
    # 统一入口
    # ------------------------------------------------------------------

    def generate(self, metric_code: str, dim_codes=None,
                 start_date=None, end_date=None):
        """统一指标查询入口：返回 (类型, SQL, 绑定参数)"""
        mtype, metric = self.find_metric(metric_code)
        if mtype == "atomic":
            start, end = self.resolve_period("custom", start_date or _default_start(), end_date)
            sql, params = self.build_atomic_sql(metric, dim_codes or [], start, end)
        elif mtype == "derived":
            sql, params = self.build_derived_sql(metric, dim_codes, start_date, end_date)
        else:
            sql, params = self.build_composite_sql(metric, dim_codes, start_date, end_date)
        return mtype, metric.name, sql, params

    def generate_sql_only(self, metric_code: str, dim_codes=None,
                          start_date=None, end_date=None):
        """只生成 SQL 不执行（口径透明，供预览/详情/审计）"""
        mtype, _name, sql, params = self.generate(
            metric_code, dim_codes, start_date, end_date)
        return mtype, sql, params

    def execute(self, metric_code: str, dim_codes=None,
                start_date=None, end_date=None):
        """生成 SQL 并执行，返回 (元信息, 列, 行)"""
        mtype, mname, sql, params = self.generate(metric_code, dim_codes, start_date, end_date)
        s = get_session()
        try:
            result = s.execute(text(sql), params)
            cols = list(result.keys())
            rows = [list(r) for r in result.fetchall()]
            return {"type": mtype, "metric_name": mname}, cols, rows, sql
        finally:
            s.close()


def _default_start():
    return (dt.date.today() - dt.timedelta(days=7)).isoformat()
