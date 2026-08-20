"""pytest 配置：使用独立临时数据库 + FastAPI TestClient（不影响 Demo 主库）"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

# 必须在导入 models 之前指定独立数据库（models.py 在 import 时读环境变量建引擎）
BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

_tmp = tempfile.mktemp(suffix=".db", prefix="metric_test_")
os.environ["METRIC_DB_PATH"] = _tmp

import seed  # noqa: E402
import main as app_module  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app)


@pytest.fixture(scope="session", autouse=True)
def _init_db():
    seed.main()  # 建表 + 种子数据
    yield
    for suffix in ("", "-wal", "-shm"):
        p = Path(_tmp + suffix)
        if p.exists():
            p.unlink()


@pytest.fixture()
def api():
    return client


@pytest.fixture(autouse=True)
def _pool_watch(request):
    """诊断：每用例结束后检查连接池是否有未归还连接（泄漏定位用）"""
    from models import engine
    yield
    pool = engine.pool
    if pool.checkedout() > 0:
        print(f"\n[POOL] {request.node.name} 后 checkedout={pool.checkedout()} "
              f"size={pool.size()} overflow={pool.overflow()}")