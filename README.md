# Agentic-Browser-MCP

**A High-Concurrency Browser MCP Server** — enable AI agents to control real browsers through the MCP protocol, ideal for products requiring users to grant browser access permissions.

[![Python](https://img.shields.io/badge/Python-3.8+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-Server-blue.svg)](https://modelcontextprotocol.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](https://github.com/MinJung-Go/Agentic-Browser-MCP/issues)

[Problem Statement](#problem-statement) • [Why](#why-agentic-browser) • [Quick Start](#quick-start) • [MCP Tools](#mcp-tools) • [Deployment](#deployment) • [Project Structure](#project-structure) • [API Endpoints](#api-endpoints) • [Contributing](#contributing)

---

## Problem Statement

Building AI products that require browser automation often faces a fundamental challenge: **how to control users' browsers securely at scale?**

Traditional solutions like Puppeteer or Playwright run in headless mode on your servers - isolated from users' real browsers with their sessions, cookies, and 2FA settings. For products that need to interact with users' actual browsing context, you need a different approach.

**agentic-browser** solves this by providing a scalable MCP (Model Context Protocol) server that bridges AI agents to users' real browsers through a lightweight Chrome extension.

---

## Why agentic-browser?

### The Use Case

Perfect for products requiring users to grant browser access:

- **AI Shopping Assistants** - Add items to user's cart on their favorite e-commerce sites
- **Form Auto-fill Services** - Fill complex forms across multiple websites
- **Account Migration Tools** - Transfer data between platforms with user's active sessions
- **Personal Research Agents** - Navigate logged-in dashboards and reports
- **Customer Support Automation** - Perform actions on user's behalf with their permissions

### Key Features

- **Real Browser Control** - Access users' actual browser context (sessions, cookies, passwords)
- **MCP Protocol Native** - Seamless integration with Claude Desktop, Cursor, and other MCP clients
- **Chrome Extension Architecture** - Secure, user-controlled permissions model
- **High Concurrency** - Redis-backed multi-worker deployment for thousands of concurrent users
- **Privacy First** - User grants explicit, revocable permission per session
- **Zero Config** - Built-in fakeredis for development, external Redis for production

---

## agentic-browser vs Playwright

| Feature | agentic-browser | Playwright |
|---------|-----------------|-------------|
| **Browser Context** | User's real browser with sessions/cookies | Isolated headless browser |
| **Deployment** | Server-side, users connect their browsers | Runs on your servers |
| **Authentication** | Uses user's existing logins | Needs credential management |
| **2FA Support** | Works seamlessly (user's device) | Complex to handle |
| **IP Geolocation** | User's actual IP/region | Your server's IP/region |
| **Scalability** | User's browser does the work | Your servers do the work |
| **Use Case** | Products needing user's browser context | Automated testing/scraping |
| **Privacy** | User controls, data stays on device | Data on your servers |
| **Cost** | Low (no server resources for browsing) | High (CPU/memory for browsers) |

**Bottom Line:** Use Playwright for testing and scraping. Use agentic-browser when you need **users' real browser context** with their permissions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User's Computer                               │
│  ┌──────────────┐                    ┌──────────────────────────────────┐  │
│  │ Chrome       │                    │ AI Application                  │  │
│  │ Extension    │◄─── WebSocket ───► │ (Claude Desktop, Cursor, etc)  │  │
│  └──────┬───────┘                    └──────────────┬───────────────┘  │
│         │                                               │                  │
│         │                                               │                  │
│         v                                               v                  │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                     User's Real Browser                        │   │
│  │  • Active sessions                                        │   │
│  │  • Saved cookies                                           │   │
│  │  • Auto-fill passwords                                     │   │
│  │  • 2FA devices                                             │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘

                                    ▲
                                    │ MCP SSE
                                    │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         agentic-browser Server                           │
│  • MCP SSE Protocol                                                 │
│  • WebSocket Connection Manager                                      │
│  • Redis-backed Multi-worker Support                                 │
│  • API: /browser-mcp/sse/{user_id}                                    │
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

**Important:** VLM is completely optional. The extension works perfectly without it - page snapshots will just include the structured elements list without the additional visual description.

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
git clone https://github.com/yourusername/agentic-browser.git
cd agentic-browser
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

Uses built-in fakeredis. Perfect for development and testing.

### Production (Multi-Worker)

```bash
# With external Redis
REDIS_URL=redis://localhost:6379/0 gunicorn -w 4 -k uvicorn.workers.UvicornWorker server:app
```

Redis enables cross-worker communication, supporting thousands of concurrent users.

---

## Project Structure

```
agentic-browser/
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

## Security & Privacy

- **User Consent**: Chrome extension requires explicit user permission to connect
- **Revocable**: User can disconnect extension anytime
- **No Credential Storage**: We never see or store user passwords
- **Sandboxed Execution**: Each browser command executes in isolated context
- **User in Control**: User sees all actions in real-time in their browser

---

## Requirements

- Python 3.8+
- Chrome/Chromium browser
- For production: Redis server

---

## Contributing

Contributions are welcome! Please feel free to submit a [Pull Request](https://github.com/MinJung-Go/Agentic-Browser-MCP/pulls) or [Issue](https://github.com/MinJung-Go/Agentic-Browser-MCP/issues).

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [MCP Protocol](https://modelcontextprotocol.io/) - Model Context Protocol
- [Claude Desktop](https://claude.ai/download) - AI assistant with MCP support
- [FastAPI](https://fastapi.tiangolo.com/) - Modern Python web framework
- [fakeredis](https://fakeredis.readthedocs.io/) - Redis emulator for development

---

<div align="center">

**If this project helps you, please give it a Star!**

Questions or suggestions? Open an [Issue](https://github.com/MinJung-Go/Agentic-Browser-MCP/issues)

Made by [MinJung-Go](https://github.com/MinJung-Go)

</div>
