/**
 * Browser MCP Chrome Extension - Popup Script
 * 处理用户配置和连接管理
 */

// DOM 元素
const serverUrlInput = document.getElementById('server-url');
const userIdInput = document.getElementById('user-id');
const vlmApiKeyInput = document.getElementById('vlm-api-key');
const vlmModelSelect = document.getElementById('vlm-model');
const vlmBaseUrlInput = document.getElementById('vlm-base-url');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const statusDiv = document.getElementById('status');
const statusText = document.getElementById('status-text');
const mcpUrlSection = document.getElementById('mcp-url-section');
const mcpUrlInput = document.getElementById('mcp-url');
const copyBtn = document.getElementById('copy-btn');
const panelSection = document.getElementById('panel-section');
const panelBtn = document.getElementById('panel-btn');
const panelBtnIcon = document.getElementById('panel-btn-icon');
const panelBtnText = document.getElementById('panel-btn-text');
const helpLink = document.getElementById('help-link');

// 默认配置
const DEFAULT_CONFIG = {
  serverUrl: 'http://localhost:8000',
  userId: '',
  vlmApiKey: '',
  vlmModel: 'gpt-4o',
  vlmBaseUrl: 'https://api.openai.com/v1'
};

/**
 * 生成用户 ID
 */
function generateUserId() {
  return 'user_' + Math.random().toString(36).substring(2, 10);
}

/**
 * 加载保存的配置
 */
async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['serverUrl', 'userId', 'vlmApiKey', 'vlmModel', 'vlmBaseUrl'], (result) => {
      const config = {
        serverUrl: result.serverUrl || 'http://localhost:8000',
        userId: result.userId || '',
        vlmApiKey: result.vlmApiKey || '',
        vlmModel: result.vlmModel || 'gpt-4o',
        vlmBaseUrl: result.vlmBaseUrl || 'https://api.openai.com/v1'
      };

      // 如果没有用户 ID，自动生成一个
      if (!config.userId) {
        config.userId = generateUserId();
      }

      resolve(config);
    });
  });
}

/**
 * 保存配置
 */
async function saveConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      serverUrl: config.serverUrl,
      userId: config.userId,
      vlmApiKey: config.vlmApiKey,
      vlmModel: config.vlmModel,
      vlmBaseUrl: config.vlmBaseUrl
    }, resolve);
  });
}

/**
 * 获取当前表单配置
 */
function getFormConfig() {
  return {
    serverUrl: serverUrlInput.value.trim(),
    userId: userIdInput.value.trim(),
    vlmApiKey: vlmApiKeyInput.value.trim(),
    vlmModel: vlmModelSelect.value,
    vlmBaseUrl: vlmBaseUrlInput.value.trim()
  };
}

/**
 * 填充表单
 */
function fillForm(config) {
  serverUrlInput.value = config.serverUrl || 'http://localhost:8000';
  userIdInput.value = config.userId || '';
  vlmApiKeyInput.value = config.vlmApiKey || '';
  vlmModelSelect.value = config.vlmModel || 'gpt-4o';
  vlmBaseUrlInput.value = config.vlmBaseUrl || 'https://api.openai.com/v1';
}

/**
 * 更新状态显示
 */
function updateStatus(connected, message) {
  statusDiv.className = 'status ' + (connected ? 'connected' : 'disconnected');
  statusText.textContent = message || (connected ? '已连接' : '未连接');

  connectBtn.style.display = connected ? 'none' : 'block';
  disconnectBtn.style.display = connected ? 'block' : 'none';

  // 禁用/启用输入框
  const inputs = [serverUrlInput, userIdInput, vlmApiKeyInput, vlmModelSelect, vlmBaseUrlInput];
  inputs.forEach(input => {
    input.disabled = connected;
  });
}

/**
 * 显示 MCP SSE 地址
 */
function showMcpUrl(serverUrl, userId) {
  const baseUrl = serverUrl.replace(/\/$/, '');
  const mcpUrl = `${baseUrl}/browser-mcp/sse/${userId}`;

  mcpUrlInput.value = mcpUrl;
  mcpUrlSection.style.display = 'block';
  panelSection.style.display = 'block';
}

/**
 * 隐藏 MCP SSE 地址
 */
function hideMcpUrl() {
  mcpUrlSection.style.display = 'none';
  panelSection.style.display = 'none';
}

/**
 * 更新控制窗口按钮状态
 */
function updatePanelButton(isOpen) {
  if (isOpen) {
    panelBtnIcon.textContent = '\u25A0';
    panelBtnText.textContent = '关闭控制窗口';
    panelBtn.classList.add('active');
  } else {
    panelBtnIcon.textContent = '\u25B6';
    panelBtnText.textContent = '打开控制窗口';
    panelBtn.classList.remove('active');
  }
}

/**
 * 切换控制窗口
 */
async function togglePanel() {
  panelBtn.disabled = true;

  try {
    const status = await chrome.runtime.sendMessage({ type: 'get_status' });

    if (status && status.panelOpen) {
      await chrome.runtime.sendMessage({ type: 'close_panel' });
      updatePanelButton(false);
    } else {
      await chrome.runtime.sendMessage({ type: 'open_panel' });
      updatePanelButton(true);
    }
  } catch (error) {
    console.error('Toggle panel error:', error);
  } finally {
    panelBtn.disabled = false;
  }
}

/**
 * 验证配置
 */
function validateConfig(config) {
  if (!config.serverUrl) {
    return { valid: false, message: '请输入服务器地址' };
  }

  try {
    new URL(config.serverUrl);
  } catch {
    return { valid: false, message: '服务器地址格式不正确' };
  }

  if (!config.userId) {
    return { valid: false, message: '请输入用户 ID' };
  }

  return { valid: true };
}

/**
 * 连接到服务器
 */
async function connect() {
  const config = getFormConfig();

  // 验证配置
  const validation = validateConfig(config);
  if (!validation.valid) {
    alert(validation.message);
    return;
  }

  // 保存配置
  await saveConfig(config);

  // 更新状态为连接中
  updateStatus(false, '连接中...');
  connectBtn.disabled = true;

  try {
    // 发送连接请求到 background script
    const response = await chrome.runtime.sendMessage({
      type: 'connect',
      config: config
    });

    if (response && response.success) {
      updateStatus(true, '已连接');
      showMcpUrl(config.serverUrl, config.userId);
    } else {
      updateStatus(false, response?.error || '连接失败');
      alert(response?.error || '连接失败，请检查服务器地址');
    }
  } catch (error) {
    console.error('Connect error:', error);
    updateStatus(false, '连接失败');
    alert('连接失败: ' + error.message);
  } finally {
    connectBtn.disabled = false;
  }
}

/**
 * 断开连接
 */
async function disconnect() {
  disconnectBtn.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'disconnect'
    });

    updateStatus(false, '未连接');
    hideMcpUrl();
  } catch (error) {
    console.error('Disconnect error:', error);
  } finally {
    disconnectBtn.disabled = false;
  }
}

/**
 * 复制 MCP URL
 */
async function copyMcpUrl() {
  const url = mcpUrlInput.value;

  try {
    await navigator.clipboard.writeText(url);

    // 显示复制成功提示
    const originalText = copyBtn.textContent;
    copyBtn.textContent = '✓';
    setTimeout(() => {
      copyBtn.textContent = originalText;
    }, 1500);
  } catch (error) {
    console.error('Copy error:', error);
    // 回退方案
    mcpUrlInput.select();
    document.execCommand('copy');
  }
}

/**
 * 检查当前连接状态
 */
async function checkConnectionStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'get_status'
    });

    if (response && response.connected) {
      updateStatus(true, '已连接');

      // 加载配置并显示 MCP URL
      const config = await loadConfig();
      if (config.serverUrl && config.userId) {
        showMcpUrl(config.serverUrl, config.userId);
      }

      // 更新控制窗口按钮状态
      updatePanelButton(response.panelOpen || false);
    } else {
      updateStatus(false, '未连接');
    }
  } catch (error) {
    console.error('Status check error:', error);
    updateStatus(false, '未连接');
  }
}

/**
 * 显示帮助
 */
function showHelp() {
  const helpMessage = `
Browser MCP 使用指南

1. 填写服务器地址（Agent Playground 后端地址）
2. 用户 ID 会自动生成，也可以自定义
3. 填写 VLM API Key（用于智能识别页面元素，可选）
4. 点击"连接"按钮
5. 复制生成的 MCP SSE 地址
6. 在 Agent Playground 中添加 MCP 服务，选择 SSE 类型，粘贴地址

提示：
- VLM 用于理解如"点击搜索按钮"这样的自然语言指令
- 支持 GPT-4o、GPT-4 Vision、Claude 3 等模型
- 如果不配置 VLM，需要使用 CSS 选择器或 XPath
  `.trim();

  alert(helpMessage);
}

/**
 * 初始化
 */
async function init() {
  // 加载配置
  const config = await loadConfig();
  fillForm(config);

  // 检查连接状态
  await checkConnectionStatus();

  // 绑定事件
  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);
  copyBtn.addEventListener('click', copyMcpUrl);
  panelBtn.addEventListener('click', togglePanel);
  helpLink.addEventListener('click', (e) => {
    e.preventDefault();
    showHelp();
  });

  // 监听来自 background 的状态变化
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'connectionStatusChanged') {
      if (message.connected) {
        updateStatus(true, '已连接');
        loadConfig().then(config => {
          if (config.serverUrl && config.userId) {
            showMcpUrl(config.serverUrl, config.userId);
          }
        });
      } else {
        updateStatus(false, message.reason || '已断开');
        hideMcpUrl();
      }
    }
    return true;
  });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
