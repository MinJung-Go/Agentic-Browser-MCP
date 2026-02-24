"""
Browser MCP Router
提供符合 MCP SSE 传输协议的端点，复用现有 MCPSSETool 机制

MCP SSE 传输协议:
1. 客户端 GET /sse/{user_id} → 服务端返回 SSE 流
2. SSE 流首先发送 event: endpoint，data 为 POST 消息端点 URL
3. 客户端 POST JSON-RPC 消息到 message 端点 → 服务端返回 202 Accepted
4. 服务端通过 SSE 流发送 event: message，data 为 JSON-RPC 响应

跨 Worker 通信:
  SSE GET 和 POST message 可能命中不同的 Gunicorn Worker，
  使用 Redis 队列路由 JSON-RPC 响应到正确的 SSE 流:

  MCP Client → POST → Worker B (任意) → 处理请求 → Redis 响应队列
  Worker A (SSE holder) → Redis BRPOP → event: message → MCP Client
"""

import json
import asyncio
import time
import uuid
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import StreamingResponse, Response

from browser_mcp.connection_manager import get_browser_mcp_manager
from logger import build_logger

logger = build_logger("browser_mcp", "browser_mcp.log")

router = APIRouter(prefix="/browser-mcp", tags=["Browser MCP"])

# 超时配置
SSE_MAX_DURATION = 1800     # SSE 会话最长持续时间 (秒): 30 分钟
SSE_IDLE_TIMEOUT = 600      # SSE 会话空闲超时 (秒): 10 分钟无请求则关闭
WS_RECEIVE_TIMEOUT = 120.0  # WebSocket 接收超时 (秒): 2 分钟无消息则断开
TOOL_CALL_TIMEOUT = 120.0   # 工具调用超时 (秒)

# Redis key 模板 (SSE 会话)
SSE_SESSION_KEY_TPL = "browser_mcp:sse_session:{}"  # String: session 存在标记
SSE_RESP_KEY_TPL = "browser_mcp:sse_resp:{}"        # List: JSON-RPC 响应队列


def _get_redis():
    """获取 Redis 连接"""
    try:
        from config import get_redis
        return get_redis()
    except Exception as e:
        logger.error(f"Failed to get Redis: {e}")
        return None


_redis = _get_redis()

# MCP 工具定义
BROWSER_TOOLS = [
    {
        "name": "browser_navigate",
        "description": "【第1步】打开指定网页，返回页面快照（含可交互元素列表）。"
                       "这是所有操作的起点。打开后查看 elements 数组，找到要操作的元素 ref 编号。"
                       "搜索流程：navigate(打开网站) → 从 elements 找到搜索框 ref → type(ref, text, submit=true) → get_content(读结果)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "完整网页URL，如 https://www.baidu.com"}
            },
            "required": ["url"]
        }
    },
    {
        "name": "browser_click",
        "description": "【交互】点击 elements 列表中指定 ref 编号的元素。"
                       "返回新的页面快照。如果 ref 失效（页面已变化），会返回错误和新的 elements 列表。"
                       "点击链接/按钮后，查看新快照判断页面状态。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ref": {"type": "number", "description": "要点击的元素 ref 编号（从 elements 列表获取）"}
            },
            "required": ["ref"]
        }
    },
    {
        "name": "browser_type",
        "description": "【交互】在 elements 列表中指定 ref 编号的输入框中输入文字。"
                       "设置 submit=true 在输入后自动按回车（适合搜索框）。返回新页面快照。"
                       "搜索时必须用此工具，不能只靠 navigate+get_content（那只看到首页）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ref": {"type": "number", "description": "输入框的 ref 编号（从 elements 列表获取）"},
                "text": {"type": "string", "description": "要输入的文字"},
                "submit": {"type": "boolean", "description": "输入后是否按回车提交，默认false，搜索框建议true"}
            },
            "required": ["ref", "text"]
        }
    },
    {
        "name": "browser_screenshot",
        "description": "【观察】获取当前页面快照（标题、URL、可交互元素列表）。"
                       "当你不确定页面状态或需要刷新元素列表时使用。"
                       "navigate/click/type/scroll 都会自动返回快照，通常不需要额外调用此工具。",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "browser_get_content",
        "description": "【读取】获取页面文本内容。用于读取搜索结果、文章正文等。"
                       "此工具只读不写。如果读到首页内容说明还没搜索，需先 type(submit=true)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "format": {"type": "string", "enum": ["text", "html", "markdown"], "description": "返回格式，默认text"}
            }
        }
    },
    {
        "name": "browser_scroll",
        "description": "【交互】滚动页面查看更多内容，返回新快照。"
                       "滚动后 elements 的 ref 会重新编号（因为可见元素变了）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["up", "down"], "description": "滚动方向"},
                "amount": {"type": "number", "description": "滚动像素数，默认500"}
            },
            "required": ["direction"]
        }
    },
    {
        "name": "browser_get_tabs",
        "description": "获取所有打开的标签页列表。",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "browser_switch_tab",
        "description": "切换到指定的标签页。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {"type": "number", "description": "标签页索引"},
                "url": {"type": "string", "description": "根据URL匹配标签页"}
            }
        }
    },
    {
        "name": "browser_new_tab",
        "description": "新建一个标签页。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "初始URL，默认为空白页"}
            }
        }
    },
    {
        "name": "browser_close_tab",
        "description": "关闭当前或指定的标签页。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {"type": "number", "description": "要关闭的标签页索引，不指定则关闭当前标签页"}
            }
        }
    }
]


# ========== 状态查询端点 ==========

@router.get("/status")
async def get_manager_status():
    """获取连接管理器状态"""
    manager = get_browser_mcp_manager()
    return manager.get_status()


@router.get("/status/{user_id}")
async def get_user_status(user_id: str):
    """获取用户的浏览器连接状态"""
    manager = get_browser_mcp_manager()
    return {"connected": manager.is_connected(user_id), "user_id": user_id}


# ========== WebSocket 端点 (Chrome 扩展) ==========

@router.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    """Chrome 扩展 WebSocket 连接端点"""
    await websocket.accept()
    manager = get_browser_mcp_manager()

    try:
        data = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)

        if data.get("type") != "register":
            await websocket.send_json({"type": "error", "message": "Expected register message"})
            await websocket.close()
            return

        browser_info = data.get("browser_info", {})
        await manager.register(user_id, websocket, browser_info)

        await websocket.send_json({
            "type": "registered",
            "user_id": user_id,
            "message": "Browser connected successfully"
        })

        logger.info(f"Browser MCP: User {user_id} connected")

        while True:
            try:
                # 限制接收超时，避免无限等待
                message = await asyncio.wait_for(
                    websocket.receive_json(), timeout=WS_RECEIVE_TIMEOUT
                )
                msg_type = message.get("type")

                if msg_type == "heartbeat":
                    await manager.update_heartbeat(user_id)
                    await websocket.send_json({"type": "heartbeat_ack"})

                elif msg_type == "response":
                    request_id = message.get("request_id")
                    if request_id:
                        await manager.handle_response(
                            user_id, request_id,
                            {"data": message.get("data"), "error": message.get("error")}
                        )

            except asyncio.TimeoutError:
                # 超时未收到任何消息 (含心跳)，主动断开
                logger.warning(f"Browser MCP: No message from {user_id} for {WS_RECEIVE_TIMEOUT}s, closing")
                await websocket.close(code=1000, reason="Idle timeout")
                break

            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON"})

    except asyncio.TimeoutError:
        logger.warning(f"Browser MCP: Timeout waiting for register from {user_id}")
        await websocket.close()
    except WebSocketDisconnect:
        logger.info(f"Browser MCP: User {user_id} disconnected")
    except Exception as e:
        logger.error(f"Browser MCP WebSocket error: {e}")
    finally:
        await manager.unregister(user_id)


# ========== MCP SSE 传输协议端点 (Redis 跨 Worker) ==========

@router.get("/sse/{user_id}")
async def mcp_sse_endpoint(user_id: str, request: Request):
    """
    MCP SSE 端点 - 符合 MCP SSE 传输协议

    流程:
    1. 发送 event: endpoint，告知 POST 消息端点 URL
    2. 持续从 Redis 响应队列读取，将 JSON-RPC 响应作为 event: message 发送

    响应通过 Redis 队列跨 Worker 传递，POST 可以命中任意 Worker。
    """
    manager = get_browser_mcp_manager()

    if not manager.is_connected(user_id):
        raise HTTPException(
            status_code=503,
            detail=f"Browser not connected for user: {user_id}. Please ensure Chrome extension is running."
        )

    if not _redis:
        raise HTTPException(status_code=503, detail="Redis unavailable for SSE session management")

    # 创建 SSE 会话，注册到 Redis
    session_id = str(uuid.uuid4())
    session_key = SSE_SESSION_KEY_TPL.format(session_id)
    resp_key = SSE_RESP_KEY_TPL.format(session_id)

    try:
        _redis.set(session_key, user_id, ex=3600)
    except Exception as e:
        logger.error(f"Redis set session error: {e}")
        raise HTTPException(status_code=503, detail="Failed to create SSE session")

    # 构造绝对 URL，包含 session_id
    # 优先使用 X-Forwarded-* 头 (反向代理场景)，否则回退到 request.base_url
    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    forwarded_host = request.headers.get("x-forwarded-host", "") or request.headers.get("host", "")
    if forwarded_proto and forwarded_host:
        base_url = f"{forwarded_proto}://{forwarded_host}"
    else:
        base_url = str(request.base_url).rstrip("/")
    message_url = f"{base_url}/browser-mcp/sse/{user_id}/message?session_id={session_id}"
    logger.info(f"SSE session created: {session_id[:8]}, message_url: {message_url}")

    async def generate():
        start_time = time.time()
        last_activity = time.time()

        try:
            # 第一步：发送 endpoint 事件
            yield f"event: endpoint\ndata: {message_url}\n\n"

            # 第二步：持续从 Redis 响应队列读取并发送
            while True:
                now = time.time()

                # 检查最大会话时长
                if now - start_time > SSE_MAX_DURATION:
                    logger.info(f"SSE session max duration reached ({SSE_MAX_DURATION}s): {session_id[:8]}")
                    break

                # 检查空闲超时
                if now - last_activity > SSE_IDLE_TIMEOUT:
                    logger.info(f"SSE session idle timeout ({SSE_IDLE_TIMEOUT}s): {session_id[:8]}")
                    break

                if await request.is_disconnected():
                    break

                if not manager.is_connected(user_id):
                    break

                try:
                    # 从 Redis 响应队列阻塞读取 (5秒超时)
                    result = await asyncio.to_thread(_redis.brpop, resp_key, 5)

                    if result:
                        last_activity = time.time()
                        resp_data = result[1]
                        if isinstance(resp_data, bytes):
                            resp_data = resp_data.decode('utf-8')
                        logger.info(f"SSE delivering message: session={session_id[:8]}, len={len(resp_data)}")
                        yield f"event: message\ndata: {resp_data}\n\n"
                    else:
                        # 超时，发送 keepalive 保持连接
                        yield ": keepalive\n\n"

                except Exception as e:
                    logger.error(f"SSE read error: {e}")
                    yield ": keepalive\n\n"
                    await asyncio.sleep(1)

        except asyncio.CancelledError:
            pass
        finally:
            elapsed = int(time.time() - start_time)
            # 清理 Redis 中的 session 和响应队列
            try:
                _redis.delete(session_key)
            except Exception:
                pass
            try:
                _redis.delete(resp_key)
            except Exception:
                pass
            logger.info(f"SSE session closed: {session_id[:8]} (duration: {elapsed}s)")

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.post("/sse/{user_id}/message")
async def mcp_message_endpoint(user_id: str, request: Request, session_id: str = ""):
    """
    MCP 消息端点 - 接收 JSON-RPC 请求，响应通过 Redis 队列回传到 SSE 流

    可以命中任意 Gunicorn Worker:
    - 验证 session 存在 (Redis)
    - 处理 JSON-RPC 请求
    - 将响应推送到 Redis 响应队列
    - SSE 所在的 Worker 从 Redis 读取并发送
    """
    if not _redis:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    # 验证 session 存在 (Redis 全局查询，任意 Worker 都能验证)
    session_key = SSE_SESSION_KEY_TPL.format(session_id)
    try:
        if not _redis.exists(session_key):
            raise HTTPException(status_code=400, detail="Invalid or expired session")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Redis exists check error: {e}")
        raise HTTPException(status_code=503, detail="Redis error")

    resp_key = SSE_RESP_KEY_TPL.format(session_id)

    # 刷新 session TTL (每次有请求说明会话仍活跃)
    try:
        _redis.expire(session_key, SSE_MAX_DURATION)
    except Exception:
        pass

    try:
        body = await request.json()
    except Exception:
        error_resp = json.dumps({
            "jsonrpc": "2.0", "id": None,
            "error": {"code": -32700, "message": "Parse error"}
        })
        _redis.lpush(resp_key, error_resp)
        _redis.expire(resp_key, 300)
        return Response(status_code=202)

    method = body.get("method", "")
    msg_id = body.get("id")

    logger.info(f"MCP message: method={method}, id={msg_id}, session={session_id[:8]}")

    # 异步处理请求，立即返回 202
    asyncio.create_task(
        _handle_mcp_request(user_id, session_id, body)
    )

    return Response(status_code=202)


async def _handle_mcp_request(user_id: str, session_id: str, body: dict):
    """异步处理 MCP JSON-RPC 请求，结果推送到 Redis 响应队列"""
    manager = get_browser_mcp_manager()
    resp_key = SSE_RESP_KEY_TPL.format(session_id)

    jsonrpc = body.get("jsonrpc", "2.0")
    method = body.get("method", "")
    params = body.get("params", {})
    msg_id = body.get("id")

    try:
        result = None

        if method == "initialize":
            result = {
                "jsonrpc": jsonrpc, "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "browser-mcp", "version": "1.0.0"},
                    "instructions": (
                        "你正在控制用户的真实浏览器。每次操作后会返回页面快照，包含可交互元素列表（elements）。\n\n"
                        "【核心流程】\n"
                        "1. browser_navigate(url) → 打开页面，获取 elements 列表\n"
                        "2. 从 elements 中找到目标元素的 ref 编号\n"
                        "3. browser_click(ref) 或 browser_type(ref, text) → 操作元素，获取新快照\n"
                        "4. browser_get_content() → 读取页面文本内容\n\n"
                        "【搜索示例】\n"
                        "1. browser_navigate('https://www.baidu.com') → 返回 elements，找到搜索框 ref=0\n"
                        "2. browser_type(ref=0, text='AI', submit=true) → 自动提交，返回搜索结果页快照\n"
                        "3. browser_get_content() → 读取搜索结果\n\n"
                        "【重要规则】\n"
                        "- 用 ref 编号指定操作目标，不要用自然语言描述\n"
                        "- 每次操作后查看返回的 elements 列表，ref 编号可能会变\n"
                        "- 搜索必须用 browser_type(submit=true)，不能只靠 navigate+get_content"
                    )
                }
            }

        elif method == "notifications/initialized":
            # 通知不需要响应
            return

        elif method == "tools/list":
            result = {
                "jsonrpc": jsonrpc, "id": msg_id,
                "result": {"tools": BROWSER_TOOLS}
            }

        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})

            tool_exists = any(t["name"] == tool_name for t in BROWSER_TOOLS)
            if not tool_exists:
                available = [t["name"] for t in BROWSER_TOOLS]
                result = {
                    "jsonrpc": jsonrpc, "id": msg_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Tool not found: {tool_name}. Available tools: {available}"}],
                        "isError": True
                    }
                }
            else:
                try:
                    data = await manager.send_command(
                        user_id=user_id, action=tool_name,
                        params=arguments, timeout=TOOL_CALL_TIMEOUT
                    )
                    if data is None:
                        data = {"success": False, "error": "No response from browser extension"}
                    logger.info(f"Tool call success: {tool_name}, data keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
                    result = {
                        "jsonrpc": jsonrpc, "id": msg_id,
                        "result": {
                            "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]
                        }
                    }
                except Exception as e:
                    # 返回 CallToolResult 格式 (isError=true) 而非 JSON-RPC error
                    # JSON-RPC error 会导致 MCP SDK 抛异常，MCPSSETool 只能返回 output=""
                    # CallToolResult 格式可以携带错误信息作为 text content，MCPSSETool 能正确提取
                    logger.warning(f"Tool call failed: {tool_name}, error: {e}")
                    result = {
                        "jsonrpc": jsonrpc, "id": msg_id,
                        "result": {
                            "content": [{"type": "text", "text": f"Error executing {tool_name}: {str(e)}"}],
                            "isError": True
                        }
                    }

        else:
            result = {
                "jsonrpc": jsonrpc, "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}
            }

        if result:
            result_json = json.dumps(result)
            _redis.lpush(resp_key, result_json)
            _redis.expire(resp_key, 300)
            # 记录推送的响应摘要
            has_error = "error" in result
            has_content = "result" in result and "content" in result.get("result", {})
            logger.info(f"MCP response pushed: method={method}, id={msg_id}, has_error={has_error}, has_content={has_content}, len={len(result_json)}")

    except Exception as e:
        logger.error(f"Error handling MCP request {method}: {e}", exc_info=True)
        try:
            # 顶层异常也用 CallToolResult 格式，避免 MCP SDK 抛异常导致 output=""
            error_result = {
                "jsonrpc": jsonrpc, "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"Internal error: {str(e)}"}],
                    "isError": True
                }
            }
            _redis.lpush(resp_key, json.dumps(error_result))
            _redis.expire(resp_key, 300)
        except Exception as redis_err:
            logger.error(f"Failed to push error response to Redis: {redis_err}")


# ========== 调试端点 ==========

@router.get("/tools")
async def list_tools():
    """列出可用的浏览器控制工具（非 MCP 格式，用于调试）"""
    return {"tools": BROWSER_TOOLS}
