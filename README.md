# Agentic-Browser-MCP

[![Python](https://img.shields.io/badge/Python-3.8+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-Server-blue.svg)](https://modelcontextprotocol.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](https://github.com/MinJung-Go/Agentic-Browser-MCP/issues)

**An MCP server and Chrome extension that let AI clients operate a user-controlled browser window through WebSocket and SSE connections.**

[Problem Statement](#problem-statement) • [Why](#why-agentic-browser) • [Quick Start](#quick-start) • [MCP Tools](#mcp-tools) • [Deployment](#deployment) • [Project Structure](#project-structure) • [API Endpoints](#api-endpoints) • [Security](#security-and-privacy) • [Contributing](#contributing)

---

## Problem Statement

Building AI products that require browser automation often faces a fundamental challenge: **how to connect an AI service to a user's existing browser while preserving user visibility and deployment controls?**

Traditional solutions like Puppeteer or Playwright run in headless mode on your servers - isolated from users' real browsers with their sessions, cookies, and 2FA settings. For products that need to interact with users' actual browsing context, you need a different approach.

**agentic-browser** provides an MCP (Model Context Protocol) bridge between AI clients and users' existing browsers through a Chrome extension. Production scalability and security depend on the surrounding authentication, TLS, Redis, and capacity configuration.

---

## Why agentic-browser?

### The Use Case

Designed for products that need users to grant browser access:

- **AI Shopping Assistants** - Add items to user's cart on their favorite e-commerce sites
- **Form Auto-fill Services** - Fill complex forms across multiple websites
- **Account Migration Tools** - Transfer data between platforms with user's active sessions
- **Personal Research Agents** - Navigate logged-in dashboards and reports
- **Customer Support Automation** - Perform actions on user's behalf with their permissions

### Key Features

- **Real Browser Control** - Operate tabs in a user's existing browser context, including authenticated sessions
- **MCP Protocol Native** - MCP tools for compatible clients such as Claude Desktop and Cursor
- **Chrome Extension Architecture** - A visible extension connection that the user can disconnect
- **Multi-Worker Routing** - Redis-backed command and response queues for multi-worker deployments
- **Local Development** - Built-in fakeredis for a single worker; external Redis is required for multi-worker deployments

---

## agentic-browser vs Playwright

| Feature | agentic-browser | Playwright |
|---------|-----------------|-------------|
| **Browser Context** | User's real browser with sessions/cookies | Isolated headless browser |
| **Deployment** | Server-side, users connect their browsers | Runs on your servers |
| **Authentication** | Uses user's existing logins | Needs credential management |
| **2FA Support** | The user can complete challenges in their browser | Requires a separate interaction strategy |
| **IP Geolocation** | User's actual IP/region | Your server's IP/region |
| **Scalability** | Browser work runs on user devices; the bridge still requires capacity planning | Browser work runs on your infrastructure |
| **Use Case** | Products needing user's browser context | Automated testing/scraping |
| **Data Flow** | Page data and optional screenshots can pass through configured bridge or VLM services | Browser data is processed by your automation stack |
| **Cost** | Depends on bridge, Redis, and optional VLM usage | Depends on browser infrastructure and workload |

**Bottom Line:** Use Playwright for testing and scraping. Use agentic-browser when you need **users' real browser context** with their permissions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User's Computer                                │
│  ┌──────────────┐                    ┌──────────────────────────────────┐   │
│  │ Chrome       │                    │ AI Application                   │   │
│  │ Extension    │◄─── WebSocket ───► │ (Claude Desktop, Cursor, etc)    │   │
│  └──────┬───────┘                    └──────────────┬───────────────────┘   │
│         │                                           │                       │
│         │                                           │                       │
│         v                                           v                       │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │                     User's Real Browser                          │       │
│  │  • Active sessions                                               │       │
│  │  • Saved cookies                                                 │       │
│  │  • Auto-fill passwords                                           │       │
│  │  • 2FA devices                                                   │       │
│  └──────────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘

                                    ▲
                                    │ MCP SSE
                                    │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         agentic-browser Server                              │
│  • MCP SSE Protocol                                                         │
│  • WebSocket Connection Manager                                             │
│  • Redis-backed Multi-worker Support                                        │
│  • API: /browser-mcp/sse/{user_id}                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Optional: VLM Integration

The Chrome extension includes **optional VLM (Vision Language Model)** support for enhanced page understanding.

### What VLM Does

When enabled, each page snapshot includes an additional text description generated by a VLM (like GPT-4o), helping AI agents:

- Understand page layout and visual structure
- Recognize the purpose of different page sections
- Provide context about what's visible on screen

### How to Enable VLM

In the Chrome extension popup, fill in the **optional** VLM fields:

- **VLM API Key**: Your OpenAI API key (or compatible VLM service)
- **VLM Model**: Model to use (e.g., `gpt-4o`, `claude-3-opus`, `gemini-pro-vision`)
- **VLM API Base URL**: API endpoint (default: `https://api.openai.com/v1`)

**Important:** VLM is optional. Without it, page snapshots still include the structured elements list but omit the additional visual description.

### VLM in Page Snapshots

When VLM is configured, page snapshots include:

```json
{
  "page": {
    "title": "Example Page",
    "url": "https://example.com",
    "elements": [
      {"ref": 0, "tag": "input", "placeholder": "Search..."},
      {"ref": 1, "tag": "button", "text": "Submit"}
    ]
  },
  "vlmDescription": "A search page with a search input field and a submit button in the center..."
}
```

This `vlmDescription` field helps AI agents better understand the page context beyond just the structured element list.

---

## Quick Start

### For Users

1. **Install the Chrome Extension**
   - Download `browser_extension/extension/` folder
   - Load in Chrome: `chrome://extensions/` → Enable Developer Mode → Load unpacked
   - Click extension icon, connect to your server

2. **Get Your MCP URL**
   - After connection, copy the MCP SSE address shown in the extension
   - Add it to Claude Desktop, Cursor, or any MCP-compatible AI client

### For Developers

```bash
# Clone and install
git clone https://github.com/MinJung-Go/Agentic-Browser-MCP.git
cd Agentic-Browser-MCP
pip install -r requirements.txt

# Start server (uses built-in fakeredis)
python server.py

# Or with external Redis for production
REDIS_URL=redis://localhost:6379/0 python server.py
```

Server runs on `http://localhost:8000`

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Open URL, return page snapshot with interactive elements |
| `browser_click` | Click element by ref number |
| `browser_type` | Input text in form field, optional submit |
| `browser_screenshot` | Get current page snapshot |
| `browser_get_content` | Extract page text content |
| `browser_scroll` | Scroll page in specified direction |
| `browser_get_tabs` | List all open tabs |
| `browser_switch_tab` | Switch to specific tab |
| `browser_new_tab` | Open new tab |
| `browser_close_tab` | Close tab |

---

## Deployment

### Development (Single Worker)

```bash
python server.py
```

Uses built-in fakeredis for local development and testing in a single process.

### Production (Multi-Worker)

```bash
# With external Redis
REDIS_URL=redis://localhost:6379/0 gunicorn -w 4 -k uvicorn.workers.UvicornWorker server:app
```

Redis enables cross-worker command and response routing. No repository benchmark currently establishes a specific concurrent-user capacity; validate throughput and latency in your own deployment environment.

---

## Project Structure

```
Agentic-Browser-MCP/
├── browser_extension/          # Chrome extension
│   └── extension/
│       ├── manifest.json
│       ├── background.js        # WebSocket client, browser control
│       ├── popup.js/html/css    # Configuration UI
│       └── icons/
├── browser_mcp/                 # MCP connection manager
│   ├── __init__.py
│   └── connection_manager.py    # WebSocket session management
├── api_router.py                # MCP API routes (SSE endpoints)
├── server.py                    # FastAPI application entry
├── config.py                    # Redis/fakeredis configuration
├── logger.py                    # Logging module
├── requirements.txt             # Python dependencies
└── README.md                    # This file
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server information |
| `/browser-mcp/status` | GET | Connection status |
| `/browser-mcp/ws/{user_id}` | WebSocket | Chrome extension connection |
| `/browser-mcp/sse/{user_id}` | GET | MCP SSE endpoint for AI clients |
| `/browser-mcp/tools` | GET | List available tools |

---

## Example Usage

### Basic Browser Automation

```
User: "Add this item to my Amazon cart"

AI (via agentic-browser):
1. browser_navigate('https://amazon.com/product-page')
2. browser_click(ref=5)  # Click 'Add to Cart' button
3. browser_screenshot()  # Verify item added
```

### With VLM Enhanced Understanding

When VLM is configured, AI gets richer context:

```
AI receives snapshot:
{
  "elements": [
    {"ref": 0, "tag": "input", "placeholder": "Search Amazon..."},
    {"ref": 1, "tag": "button", "text": "Go"},
    ...
  ],
  "vlmDescription": "Amazon homepage with a large search bar centered,
                    navigation menu showing 'Today's Deals', 'Customer Service',
                    and a cart icon with 0 items in the top right corner."
}

AI: "I can see this is Amazon's homepage. There's a search bar at ref=0.
     I'll search for your product..."
```

---

## Security and Privacy

See [SECURITY.md](SECURITY.md) for the security model, deployment requirements, reportable issues, and private reporting process.

> [!WARNING]
> The current server endpoints do not provide built-in authentication or authorization. `user_id` and `session_id` are routing identifiers, not credentials. Do not expose the WebSocket, SSE, or message endpoints directly to an untrusted network; place them behind authenticated TLS termination and restrict Redis access.

- **Extension permissions**: The extension requests tab, scripting, storage, display, and `<all_urls>` access so it can perform browser actions. Users can disconnect or disable the extension, but deployments should explain this permission scope before installation.
- **Data transit**: Browser actions can send page structure and content through the configured bridge. When VLM mode is enabled, screenshots and the configured API key are sent to the selected VLM endpoint.
- **Local storage**: VLM configuration is stored in `chrome.storage.local`; protect the browser profile and do not reuse high-privilege API keys.
- **Redis**: Multi-worker deployments place connection metadata and command or response payloads in Redis. Queue and SSE keys use TTLs, while connection-hash cleanup depends on disconnect handling. Use authentication, TLS where available, network isolation, and operational cleanup for external Redis.
- **User visibility**: Actions run in a dedicated browser window and remain visible to the user, but visibility is not a substitute for server-side authentication and authorization.

---

## Requirements

- Python 3.8+
- Chrome/Chromium browser
- For production: Redis server

---

## Acknowledgments

- [MCP Protocol](https://modelcontextprotocol.io/) - Model Context Protocol
- [Claude Desktop](https://claude.ai/download) - AI assistant with MCP support
- [FastAPI](https://fastapi.tiangolo.com/) - Modern Python web framework
- [fakeredis](https://fakeredis.readthedocs.io/) - Redis emulator for development

---

## Contributing

Contributions are welcome! Please feel free to submit a [Pull Request](https://github.com/MinJung-Go/Agentic-Browser-MCP/pulls) or [Issue](https://github.com/MinJung-Go/Agentic-Browser-MCP/issues).

---

## License

MIT License - see [LICENSE](LICENSE) for details.
