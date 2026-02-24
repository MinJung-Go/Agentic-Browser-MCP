"""
Browser MCP Module
提供远程浏览器控制能力，复用现有 MCPSSETool 机制
"""

from .connection_manager import (
    BrowserMCPConnectionManager,
    BrowserConnection,
    get_browser_mcp_manager
)

__all__ = [
    "BrowserMCPConnectionManager",
    "BrowserConnection",
    "get_browser_mcp_manager",
]
