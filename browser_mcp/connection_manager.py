"""
Browser MCP Connection Manager
管理 Chrome 扩展的 WebSocket 连接，通过 Redis 实现跨 Gunicorn Worker 通信

架构:
  Chrome Extension → WebSocket → Worker A (持有 WebSocket)
  MCPSSETool → SSE/POST → 任意 Worker → Redis 队列 → Worker A → WebSocket → Chrome
"""

import asyncio
import json
import os
import time
import uuid
from typing import Dict, Optional, Any
from dataclasses import dataclass, field
from fastapi import WebSocket
from logger import build_logger

logger = build_logger("browser_mcp", "browser_mcp.log")

# Redis key 前缀
REDIS_PREFIX = "browser_mcp"
CONN_KEY = f"{REDIS_PREFIX}:conn"          # Hash: user_id -> connection info JSON
CMD_KEY_TPL = f"{REDIS_PREFIX}:cmd:{{}}"   # List: command queue per user
RESP_KEY_TPL = f"{REDIS_PREFIX}:resp:{{}}" # List: response queue per request
CONN_TTL = 120  # 连接注册 TTL (秒)


def _get_redis():
    """获取 Redis 连接"""
    try:
        from config import get_redis
        return get_redis()
    except Exception as e:
        logger.error(f"Failed to get Redis connection: {e}")
        return None


@dataclass
class BrowserConnection:
    """浏览器连接信息（本地 Worker 内存中的 WebSocket 连接）"""
    user_id: str
    websocket: WebSocket
    connected_at: float = field(default_factory=time.time)
    last_heartbeat: float = field(default_factory=time.time)
    browser_info: Dict[str, Any] = field(default_factory=dict)
    pending_requests: Dict[str, asyncio.Future] = field(default_factory=dict)
    _command_listener_task: Optional[asyncio.Task] = field(default=None, repr=False)

    @property
    def is_alive(self) -> bool:
        return time.time() - self.last_heartbeat < 120


class BrowserMCPConnectionManager:
    """Browser MCP 连接管理器 - Redis 跨 Worker 通信"""

    def __init__(self):
        self._connections: Dict[str, BrowserConnection] = {}
        self._lock = asyncio.Lock()
        self._redis = _get_redis()
        self._worker_id = f"{os.getpid()}"

    def _redis_available(self) -> bool:
        return self._redis is not None

    # ========== 连接注册 (Redis 全局) ==========

    async def register(self, user_id: str, websocket: WebSocket, browser_info: Dict = None) -> bool:
        """注册浏览器连接 - 本地保存 WebSocket + Redis 全局注册"""
        async with self._lock:
            # 关闭旧连接
            if user_id in self._connections:
                old_conn = self._connections[user_id]
                if old_conn._command_listener_task:
                    old_conn._command_listener_task.cancel()
                try:
                    await old_conn.websocket.close()
                except Exception:
                    pass
                for future in old_conn.pending_requests.values():
                    if not future.done():
                        future.set_exception(ConnectionError("Connection replaced"))

            conn = BrowserConnection(
                user_id=user_id,
                websocket=websocket,
                browser_info=browser_info or {}
            )
            self._connections[user_id] = conn

            # 注册到 Redis
            if self._redis_available():
                conn_info = json.dumps({
                    "worker_id": self._worker_id,
                    "connected_at": conn.connected_at,
                    "browser_info": browser_info or {}
                })
                try:
                    self._redis.hset(CONN_KEY, user_id, conn_info)
                except Exception as e:
                    logger.error(f"Redis hset error: {e}")

            # 启动 Redis 命令监听器
            conn._command_listener_task = asyncio.create_task(
                self._command_listener(user_id)
            )

            logger.info(f"Browser connected for user: {user_id} (worker: {self._worker_id})")
            return True

    async def unregister(self, user_id: str):
        """注销浏览器连接"""
        async with self._lock:
            if user_id in self._connections:
                conn = self._connections.pop(user_id)
                if conn._command_listener_task:
                    conn._command_listener_task.cancel()
                for future in conn.pending_requests.values():
                    if not future.done():
                        future.set_exception(ConnectionError("Connection closed"))

                # 从 Redis 删除
                if self._redis_available():
                    try:
                        self._redis.hdel(CONN_KEY, user_id)
                    except Exception as e:
                        logger.error(f"Redis hdel error: {e}")

                logger.info(f"Browser disconnected for user: {user_id}")

    def is_connected(self, user_id: str) -> bool:
        """检查用户是否已连接（通过 Redis 全局查询）"""
        if self._redis_available():
            try:
                return self._redis.hexists(CONN_KEY, user_id)
            except Exception as e:
                logger.error(f"Redis hexists error: {e}")

        # Redis 不可用时回退到本地检查
        conn = self._connections.get(user_id)
        return conn is not None and conn.is_alive

    def is_connected_locally(self, user_id: str) -> bool:
        """检查本 Worker 是否持有该用户的 WebSocket"""
        conn = self._connections.get(user_id)
        return conn is not None and conn.is_alive

    async def update_heartbeat(self, user_id: str):
        """更新心跳"""
        if user_id in self._connections:
            self._connections[user_id].last_heartbeat = time.time()

    # ========== 命令发送 (通过 Redis 队列跨 Worker) ==========

    async def send_command(
        self,
        user_id: str,
        action: str,
        params: Dict[str, Any] = None,
        timeout: float = 60.0
    ) -> Dict[str, Any]:
        """发送命令到浏览器 - 通过 Redis 队列跨 Worker 通信"""
        # 如果本地有连接，直接发送
        if self.is_connected_locally(user_id):
            return await self._send_command_local(user_id, action, params, timeout)

        # 否则通过 Redis 队列转发
        if not self._redis_available():
            raise ConnectionError(f"No local connection and Redis unavailable for user: {user_id}")

        return await self._send_command_via_redis(user_id, action, params, timeout)

    async def _send_command_local(
        self, user_id: str, action: str, params: Dict[str, Any] = None, timeout: float = 60.0
    ) -> Dict[str, Any]:
        """直接通过本地 WebSocket 发送命令"""
        conn = self._connections.get(user_id)
        if not conn:
            raise ConnectionError(f"No browser connection for user: {user_id}")

        request_id = str(uuid.uuid4())
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        conn.pending_requests[request_id] = future

        try:
            message = {
                "type": "command",
                "request_id": request_id,
                "action": action,
                "params": params or {}
            }
            await conn.websocket.send_json(message)
            result = await asyncio.wait_for(future, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            raise TimeoutError(f"Browser command timeout: {action}")
        finally:
            conn.pending_requests.pop(request_id, None)

    async def _send_command_via_redis(
        self, user_id: str, action: str, params: Dict[str, Any] = None, timeout: float = 60.0
    ) -> Dict[str, Any]:
        """通过 Redis 队列转发命令到持有 WebSocket 的 Worker"""
        request_id = str(uuid.uuid4())
        cmd_key = CMD_KEY_TPL.format(user_id)
        resp_key = RESP_KEY_TPL.format(request_id)

        command = json.dumps({
            "request_id": request_id,
            "action": action,
            "params": params or {}
        })

        try:
            # 推送命令到 Redis 队列
            self._redis.lpush(cmd_key, command)
            self._redis.expire(cmd_key, 300)

            # 阻塞等待响应
            result = await asyncio.to_thread(
                self._redis.brpop, resp_key, int(timeout)
            )

            if result is None:
                raise TimeoutError(f"Browser command timeout via Redis: {action}")

            response = json.loads(result[1])
            if response.get("error"):
                raise Exception(response["error"])
            return response.get("data", {})

        finally:
            # 清理响应 key
            try:
                self._redis.delete(resp_key)
            except Exception:
                pass

    # ========== Redis 命令监听器 (在持有 WebSocket 的 Worker 中运行) ==========

    async def _command_listener(self, user_id: str):
        """后台任务：监听 Redis 命令队列，转发到本地 WebSocket"""
        cmd_key = CMD_KEY_TPL.format(user_id)
        logger.info(f"Command listener started for user: {user_id}")

        while user_id in self._connections:
            try:
                # 阻塞等待命令（5秒超时后重试，以便检查连接状态）
                result = await asyncio.to_thread(
                    self._redis.brpop, cmd_key, 5
                )

                if result is None:
                    continue

                command = json.loads(result[1])
                request_id = command["request_id"]
                action = command["action"]
                params = command.get("params", {})
                resp_key = RESP_KEY_TPL.format(request_id)

                try:
                    # 通过本地 WebSocket 执行命令
                    data = await self._send_command_local(user_id, action, params, timeout=120.0)
                    response = json.dumps({"data": data})
                except Exception as e:
                    response = json.dumps({"error": str(e)})

                # 推送响应到 Redis
                try:
                    self._redis.lpush(resp_key, response)
                    self._redis.expire(resp_key, 120)
                except Exception as e:
                    logger.error(f"Redis push response error: {e}")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Command listener error for {user_id}: {e}")
                await asyncio.sleep(1)

        logger.info(f"Command listener stopped for user: {user_id}")

    # ========== WebSocket 响应处理 ==========

    async def handle_response(self, user_id: str, request_id: str, result: Dict[str, Any]):
        """处理浏览器返回的 WebSocket 响应"""
        conn = self._connections.get(user_id)
        if not conn:
            return

        future = conn.pending_requests.get(request_id)
        if future and not future.done():
            if result.get("error"):
                future.set_exception(Exception(result["error"]))
            else:
                future.set_result(result.get("data", {}))

    # ========== 状态查询 ==========

    def get_status(self) -> Dict[str, Any]:
        """获取连接状态（Redis 全局）"""
        status = {
            "worker_id": self._worker_id,
            "local_connections": len(self._connections),
        }

        if self._redis_available():
            try:
                all_conns = self._redis.hgetall(CONN_KEY)
                status["total_connections"] = len(all_conns)
                status["connections"] = {}
                for uid, info_raw in all_conns.items():
                    uid_str = uid.decode() if isinstance(uid, bytes) else uid
                    info = json.loads(info_raw)
                    status["connections"][uid_str] = info
            except Exception as e:
                logger.error(f"Redis hgetall error: {e}")
                status["total_connections"] = len(self._connections)
        else:
            status["total_connections"] = len(self._connections)

        return status


# 全局单例
_manager: Optional[BrowserMCPConnectionManager] = None


def get_browser_mcp_manager() -> BrowserMCPConnectionManager:
    """获取全局连接管理器实例"""
    global _manager
    if _manager is None:
        _manager = BrowserMCPConnectionManager()
    return _manager
