"""
配置管理 - 默认使用 fakeredis（纯 Python 内存 Redis 模拟）
"""
import os

# Redis 配置
REDIS_URL = os.getenv("REDIS_URL", "")

# Redis 客户端
_redis_client = None


def _connect_to_redis(url):
    """连接到指定的 Redis 服务器"""
    try:
        import redis
        client = redis.from_url(url, decode_responses=True)
        client.ping()  # 测试连接
        print(f"[Config] Connected to Redis: {url}")
        return client
    except Exception as e:
        print(f"[Config] Redis connection failed: {e}")
        return None


def _start_fakeredis():
    """使用 fakeredis 作为默认 Redis 实现"""
    try:
        from fakeredis import FakeStrictRedis
        client = FakeStrictRedis(decode_responses=True)
        client.ping()  # 测试连接
        print("[Config] Using fakeredis (in-memory Redis emulation)")
        print("[Config] Note: fakeredis doesn't support cross-process communication")
        print("[Config]       Single-worker mode only. For multi-worker, use external Redis:")
        print("[Config]       Set REDIS_URL=redis://localhost:6379/0")
        return client
    except ImportError:
        print("[Config] fakeredis not available. Install with: pip install fakeredis")
        return None
    except Exception as e:
        print(f"[Config] Failed to start fakeredis: {e}")
        return None


# 初始化 Redis（默认启用）
if REDIS_URL:
    # 使用配置的外部 Redis
    _redis_client = _connect_to_redis(REDIS_URL)
else:
    # 使用 fakeredis（默认）
    _redis_client = _start_fakeredis()

if _redis_client:
    print("[Config] Redis mode enabled")
else:
    print("[Config] Error: Redis initialization failed")


def get_redis():
    """获取 Redis 客户端"""
    return _redis_client


# 向后兼容：MEMORY 引用
MEMORY = get_redis()
