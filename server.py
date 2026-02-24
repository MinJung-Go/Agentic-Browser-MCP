"""
agentic-browser 主服务入口
让 AI 通过 MCP 协议控制用户的真实浏览器
"""
import os
import uvicorn
from fastapi import FastAPI
import api_router
browser_mcp_router = api_router.router

app = FastAPI(
    title="Agentic Browser MCP",
    description="让 AI 通过 MCP 协议控制用户的真实浏览器",
    version="1.0.0"
)

app.include_router(browser_mcp_router)

@app.get("/")
async def root():
    return {
        "name": "agentic-browser",
        "description": "Browser MCP Server - Chrome扩展连接后可使用AI控制浏览器",
        "docs": "/docs",
        "endpoints": {
            "websocket": "/browser-mcp/ws/{user_id}",
            "mcp_sse": "/browser-mcp/sse/{user_id}",
            "status": "/browser-mcp/status"
        }
    }

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )
