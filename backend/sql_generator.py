"""SQL 动态生成器（逻辑层核心）

DataMetric 模式：查询时根据元数据动态拼装 SQL，不预生成视图。
流程：指标编码 -> 查元数据 -> 取计算公式/维度映射/物理映射 -> 拼装 SQL
"""
import datetime as dt

from sqlalchemy import text
from sqlalchemy.orm import joinedload

from models import get_session, AtomicMetric, DerivedMetric, CompositeMetric, Dimension

# SQLite 安全白名单校验
import re

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# JOIN ON 仅允许 ident[.ident] = ident[.ident]，可用 AND 连接
_ON_EQ_RE = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?"
    r"\s*=\s*"
    r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$"
)
_FILTER_OPS = ("=", "!=", ">", "<", ">=", "<=", "IN", "NOT IN", "BETWEEN", "LIKE")

# 日期粒度 -> SQLite strftime 格式（白名单映射，粒度值不直接进入 SQL）
GRANULARITY_FMT = {"day": "%Y-%m-%d", "week": "%Y-W%W", "month": "%Y-%m"}


def _safe_ident(name: str) -> str:
    if not _IDENT_RE.match(name or ""):
        raise ValueError(f"非法标识符: {name!r}")
    return name


def _safe_join_on(on: str) -> str:
    """校验逻辑模型 JOIN ON：只允许等值连接，禁止注入片段"""
    raw = (on or "").strip()
    if not raw:
        raise ValueError("JOIN ON 条件不能为空")
    parts = [p.strip() for p in raw.split(" AND ") if p.strip()]
    if not parts or not all(_ON_EQ_RE.match(p) for p in parts):
        raise ValueError(f"非法 JOIN 条件: {on!r}，仅支持 a.col = b.col（可用 AND 连接）")
    return raw


def _append_filters(alias: str, filters, prefix: str, where_clauses: list, where_params: dict):
    """业务限定：值全部参数化；支持 IN / NOT IN / BETWEEN / LIKE 等"""
    for f in (filters or []):
        fld = _safe_ident(f["field"])
        op = f["op"]
        if op not in _FILTER_OPS:
            raise ValueError(f"不支持的操作符: {op}")
        key = f"{prefix}_f{len(where_params)}"
        if op in ("IN", "NOT IN"):
            vals = f["value"] if isinstance(f["value"], list) else [f["value"]]
            if not vals:
                raise ValueError(f"{op} 值不能为空")
            ph = ", ".join(f":{key}_{i}" for i in range(len(vals)))
            where_clauses.append(f"{alias}.{fld} {op} ({ph})")
            for i, v in enumerate(vals):
                where_params[f"{key}_{i}"] = v
        elif op == "BETWEEN":
            vals = f["value"] if isinstance(f["value"], list) else [f["value"]]
            if len(vals) != 2:
                raise ValueError("BETWEEN 需要两个值")
            where_clauses.append(
                f"{alias}.{fld} BETWEEN :{key}_a AND :{key}_b")
            where_params[f"{key}_a"] = vals[0]
            where_params[f"{key}_b"] = vals[1]
        else:
            where_clauses.append(f"{alias}.{fld} {op} :{key}")
            where_params[key] = f["value"]


def _agg_expr(agg: str, expr: str) -> str:
    """聚合函数 SQL 表达式：COUNT_DISTINCT 需翻译为 COUNT(DISTINCT x)
    （SQLite 无原生 COUNT_DISTINCT 函数），其余聚合原样拼接"""
    if agg == "COUNT_DISTINCT":
        return f"COUNT(DISTINCT {expr})"
    return f"{_safe_ident(agg)}({expr})"


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
                         filters=None, prefix="", bucket_fmt=None):
        """原子指标 SQL：AGG(物理字段) FROM 事实表 JOIN 维度表
        prefix 用于复合指标子查询参数键去重
        bucket_fmt 传入 strftime 格式时，输出 date_bucket 分组列（日/周/月粒度）"""
        table = _safe_ident(metric.process.physical_table)
        date_field = _safe_ident(metric.process.date_field)
        agg = metric.agg_function
        field = _safe_ident(metric.physical_field)

        select_cols, join_clauses, group_cols, where_params = [], [], [], {}

        # 日期桶列（粒度分组），基于指标自身日期字段构造
        if bucket_fmt:
            bucket = f"strftime('{bucket_fmt}', t.{date_field})"
            select_cols.append(f"{bucket} AS date_bucket")
            group_cols.append(bucket)

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

        _append_filters("t", filters, prefix, where_clauses, where_params)

        dims_part = (", " + ", ".join(select_cols)) if select_cols else ""
        group_part = (" GROUP BY " + ", ".join(group_cols)) if group_cols else ""
        join_part = (" " + " ".join(join_clauses)) if join_clauses else ""

        sql = (
            f"SELECT {_agg_expr(agg, f't.{field}')} AS metric_value{dims_part}\n"
            f"FROM {table} t{join_part}\n"
            f"WHERE {' AND '.join(where_clauses)}{group_part}"
        )
        return sql, where_params

    def build_derived_sql(self, metric: DerivedMetric, dim_codes=None,
                          start_date=None, end_date=None, prefix="",
                          bucket_fmt=None):
        """派生指标 SQL：原子指标 + 时间周期 + 统计维度 + 业务限定"""
        use_dims = dim_codes if dim_codes is not None else (metric.dim_codes or [])
        start, end = self.resolve_period(metric.time_period, start_date, end_date)
        filters = list(metric.filters or [])
        return self.build_atomic_sql(metric.atomic, use_dims, start, end,
                                     filters, prefix, bucket_fmt)

    def build_composite_sql(self, metric: CompositeMetric, dim_codes=None,
                            start_date=None, end_date=None, bucket_fmt=None):
        """复合指标 SQL：各派生指标生成子查询，按维度/日期桶 JOIN 后套表达式"""
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
                dm, eff_dims, start_date, end_date, prefix=f"s{i}",
                bucket_fmt=bucket_fmt)
            merged_params.update(sub_params)
            subs.append((f"t{i}", dm.code, sub_sql))

        select_expr = metric.expression
        for alias, ref, _ in subs:
            select_expr = select_expr.replace(ref, f"{alias}.metric_value")
        # 缺维度行补 0；CAST + NULLIF 防整数除 / 除零
        if "/" in select_expr:
            select_expr = re.sub(
                r"(\S+\.metric_value)\s*/\s*(\S+\.metric_value)",
                r"CAST(COALESCE(\1, 0) AS REAL) / NULLIF(COALESCE(\2, 0), 0)",
                select_expr)
        else:
            for alias, _ref, _ in subs:
                select_expr = select_expr.replace(
                    f"{alias}.metric_value", f"COALESCE({alias}.metric_value, 0)")

        if not has_dims or len(subs) == 1:
            bucket_sel = ", t0.date_bucket" if bucket_fmt else ""
            sql = f"SELECT {select_expr} AS metric_value{bucket_sel}\nFROM (\n{subs[0][2]}\n) t0"
            for alias, ref, sub_sql in subs[1:]:
                sql += f"\nCROSS JOIN (\n{sub_sql}\n) {alias}"
            return sql, merged_params

        # 带维度：先 UNION 各子查询的维度键，再 LEFT JOIN，避免 INNER JOIN 丢掉单边有数的分组
        key_cols = (["date_bucket"] if bucket_fmt else []) + list(eff_dims)
        key_list = ", ".join(key_cols)
        union_sql = " UNION ".join(
            f"SELECT {key_list} FROM (\n{sub_sql}\n)" for _a, _c, sub_sql in subs)
        dim_select = ", ".join(f"k.{dc}" for dc in eff_dims)
        bucket_sel = ", k.date_bucket" if bucket_fmt else ""
        sql = (
            f"SELECT {select_expr} AS metric_value{bucket_sel}, {dim_select}\n"
            f"FROM (\n{union_sql}\n) k\n"
        )
        for alias, _ref, sub_sql in subs:
            on_parts = " AND ".join(f"k.{c} = {alias}.{c}" for c in key_cols)
            sql += f"LEFT JOIN (\n{sub_sql}\n) {alias} ON {on_parts}\n"
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

    # ------------------------------------------------------------------
    # 多指标联合查询（统一指标查询：多指标 x 多维度 x 日/周/月粒度）
    # ------------------------------------------------------------------

    @staticmethod
    def _metric_physical_tables(mtype, metric):
        """指标涉及的物理表集合（用于维度兼容校验）"""
        if mtype == "atomic":
            return {metric.process.physical_table}
        if mtype == "derived":
            return {metric.atomic.process.physical_table}
        # 复合指标：所有被引用派生指标的物理表
        tables = set()
        s = get_session()
        try:
            for ref in metric.ref_codes or []:
                dm = (s.query(DerivedMetric)
                      .options(joinedload(DerivedMetric.atomic).joinedload(AtomicMetric.process))
                      .filter_by(code=ref).first())
                if dm:
                    tables.add(dm.atomic.process.physical_table)
        finally:
            s.close()
        return tables

    @staticmethod
    def _table_columns(table_name: str) -> set:
        """物理表列集合（SQLite pragma，用于维度兼容校验）"""
        s = get_session()
        try:
            rows = s.execute(text("SELECT name FROM pragma_table_info(:t)"),
                             {"t": table_name}).fetchall()
            return {r[0] for r in rows}
        finally:
            s.close()

    def generate_multi(self, metric_codes, dim_codes=None,
                       start_date=None, end_date=None, granularity="day"):
        """多指标联合查询 SQL：每指标一个带日期桶/维度的聚合子查询，
        按 date_bucket + 公共维度 LEFT JOIN 对齐，输出
        [date_bucket, 维度..., 指标1, 指标2, ...]"""
        if not metric_codes:
            raise ValueError("至少选择一个指标")
        if granularity not in GRANULARITY_FMT:
            raise ValueError(f"不支持的日期粒度: {granularity}")
        bucket_fmt = GRANULARITY_FMT[granularity]
        dim_codes = dim_codes or []

        dims = [self.resolve_dimension(dc) for dc in dim_codes]

        mtypes, mnames, subs, merged_params = [], [], [], {}
        for i, code in enumerate(metric_codes):
            mtype, metric = self.find_metric(code)
            mtypes.append(mtype)
            mnames.append(metric.name)

            # 维度兼容校验：维度关联字段必须存在于指标涉及的物理表中
            tables = self._metric_physical_tables(mtype, metric)
            for dc, dim in zip(dim_codes, dims):
                if not any(dim.join_field in self._table_columns(t) for t in tables):
                    raise ValueError(
                        f"指标 {code} 不支持维度 {dc}（关联字段 {dim.join_field} "
                        f"不存在于其物理表 {', '.join(sorted(tables))}）")

            if mtype == "atomic":
                start, end = self.resolve_period(
                    "custom", start_date or _default_start(), end_date)
                sub_sql, sub_params = self.build_atomic_sql(
                    metric, dim_codes, start, end, prefix=f"s{i}",
                    bucket_fmt=bucket_fmt)
            elif mtype == "derived":
                sub_sql, sub_params = self.build_derived_sql(
                    metric, dim_codes, start_date, end_date, prefix=f"s{i}",
                    bucket_fmt=bucket_fmt)
            else:
                sub_sql, sub_params = self.build_composite_sql(
                    metric, dim_codes, start_date, end_date, bucket_fmt=bucket_fmt)
            merged_params.update(sub_params)
            subs.append((f"m{i}", code, sub_sql))

        select_parts = (["m0.date_bucket"]
                        + [f"m0.{dc}" for dc in dim_codes]
                        + [f"{alias}.metric_value AS {_safe_ident(c)}"
                           for alias, c, _ in subs])
        sql = f"SELECT {', '.join(select_parts)}\nFROM (\n{subs[0][2]}\n) m0"
        for alias, _code, sub_sql in subs[1:]:
            on_parts = [f"m0.date_bucket = {alias}.date_bucket"]
            on_parts += [f"m0.{dc} = {alias}.{dc}" for dc in dim_codes]
            sql += (f"\nLEFT JOIN (\n{sub_sql}\n) {alias}"
                    f" ON {' AND '.join(on_parts)}")
        return mtypes, mnames, sql, merged_params

    def execute_multi(self, metric_codes, dim_codes=None,
                      start_date=None, end_date=None, granularity="day"):
        """多指标联合查询并执行，返回 (元信息, 列, 行)"""
        mtypes, mnames, sql, params = self.generate_multi(
            metric_codes, dim_codes, start_date, end_date, granularity)
        s = get_session()
        try:
            result = s.execute(text(sql), params)
            cols = list(result.keys())
            rows = [list(r) for r in result.fetchall()]
            return ({"metric_names": mnames, "metric_types": mtypes,
                     "granularity": granularity}, cols, rows, sql)
        finally:
            s.close()

    @staticmethod
    def logical_model_sql(m):
        """逻辑模型宽表 SQL：主物理表全字段 + join_config 关联表全字段"""
        t = _safe_ident(m.physical_table)
        joins = []
        for i, j in enumerate(m.join_config or []):
            tbl = j.get("table", "")
            if not tbl:
                continue
            at = _safe_ident(tbl)
            alias = _safe_ident(j.get("alias", f"d{i}"))
            on = _safe_join_on(j.get("on", ""))
            joins.append(f"LEFT JOIN {at} {alias} ON {on}")
        select_cols = ", ".join(["t.*"] + [f"{_safe_ident(j.get('alias', 'd' + str(i)))}.*"
                                           for i, j in enumerate(m.join_config or [])])
        sql = f"SELECT {select_cols}\nFROM {t} t"
        if joins:
            sql += "\n" + "\n".join(joins)
        return sql

    def generate_downstream_sql(self, model, source_lm=None):
        """下游模型定义 SQL（DWS 指标汇总表语义，不落地）
        FROM 逻辑模型宽表，按日期桶 + 公共维度聚合各指标；
        派生指标应用其内置时间周期窗口与业务限定；复合指标需先展开，排除。
        返回 (sql, params)，物化时 CREATE TABLE dl_{code} AS <sql> 并绑定参数"""
        lm = source_lm or model.source_model
        if not lm:
            raise ValueError("来源逻辑模型不存在")
        fmt = GRANULARITY_FMT.get(model.granularity)
        if not fmt:
            raise ValueError(f"不支持的日期粒度: {model.granularity}")
        if not (model.metrics or []):
            raise ValueError("下游模型至少配置一个指标")
        lm_sql = self.logical_model_sql(lm)
        lm_tables = {lm.physical_table} | {j.get("table") for j in (lm.join_config or [])}

        # 公共维度：所有指标条目维度取并集（按出现顺序），子查询按公共维度对齐
        pub_dims, seen = [], set()
        for mc in model.metrics:
            for dc in mc.get("dim_codes") or []:
                if dc not in seen:
                    seen.add(dc)
                    pub_dims.append(dc)
        dims = [self.resolve_dimension(dc) for dc in pub_dims]

        subs, merged_params = [], {}
        for i, mc in enumerate(model.metrics):
            code = mc["metric_code"]
            mtype, metric = self.find_metric(code)
            if mtype == "composite":
                raise ValueError(f"复合指标 {code} 不能直接用于下游模型，请先展开为派生指标")
            mtables = self._metric_physical_tables(mtype, metric)
            if not mtables.issubset(lm_tables):
                raise ValueError(
                    f"指标 {code} 的物理表 {', '.join(sorted(mtables))} "
                    f"不在逻辑模型 {lm.code} 范围内")
            for dc, dim in zip(pub_dims, dims):
                if not any(dim.join_field in self._table_columns(t) for t in mtables):
                    raise ValueError(f"指标 {code} 不支持维度 {dc}")

            date_field = (metric.process.date_field if mtype == "atomic"
                          else metric.atomic.process.date_field)
            bucket = f"strftime('{fmt}', lm.{_safe_ident(date_field)})"
            select_cols, group_cols, where_clauses, params = (
                [f"{bucket} AS date_bucket"], [bucket], [], {})
            for dc, dim in zip(pub_dims, dims):
                select_cols.append(f"lm.{_safe_ident(dim.name_field)} AS {dc}")
                group_cols.append(f"lm.{_safe_ident(dim.name_field)}")

            if mtype == "derived":
                # 派生指标：内置时间周期窗口 + 业务限定
                period = metric.time_period
                if period == "custom":
                    raise ValueError(
                        f"派生指标 {code} 为 custom 周期，不能用于物化下游模型")
                start, end = self.resolve_period(period)
                where_clauses += [f"lm.{_safe_ident(date_field)} >= :p{i}_start",
                                  f"lm.{_safe_ident(date_field)} <= :p{i}_end"]
                params[f"p{i}_start"] = start.isoformat()
                params[f"p{i}_end"] = end.isoformat()
                _append_filters("lm", metric.filters, f"p{i}", where_clauses, params)

            # 聚合口径：派生指标取其底层原子指标（派生本身无 agg_function）
            base = metric.atomic if mtype == "derived" else metric
            agg = base.agg_function
            field = _safe_ident(base.physical_field)
            select_cols.append(f"{_agg_expr(agg, f'lm.{field}')} AS metric_value")
            where_part = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            sub_sql = ("SELECT " + ", ".join(select_cols)
                       + f"\nFROM (\n{lm_sql}\n) lm"
                       + where_part + "\nGROUP BY " + ", ".join(group_cols))
            merged_params.update(params)
            subs.append((f"m{i}", code, sub_sql))

        select_parts = (["m0.date_bucket"]
                        + [f"m0.{dc}" for dc in pub_dims]
                        + [f"{alias}.metric_value AS {_safe_ident(c)}"
                           for alias, c, _ in subs])
        sql = f"SELECT {', '.join(select_parts)}\nFROM (\n{subs[0][2]}\n) m0"
        for alias, _code, sub_sql in subs[1:]:
            on_parts = [f"m0.date_bucket = {alias}.date_bucket"]
            on_parts += [f"m0.{dc} = {alias}.{dc}" for dc in pub_dims]
            sql += (f"\nLEFT JOIN (\n{sub_sql}\n) {alias}"
                    f" ON {' AND '.join(on_parts)}")
        return sql, merged_params

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
