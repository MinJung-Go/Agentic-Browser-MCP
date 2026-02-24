/**
 * Browser MCP Agent - Background Service Worker
 * 通过 WebSocket 连接到后端，执行浏览器控制命令
 *
 * AI 操作在独立的"受控窗口"中执行，不影响用户的主浏览器窗口。
 */

// 配置
let config = {
  serverUrl: 'http://localhost:8000',
  userId: '',
  vlmApiKey: '',
  vlmModel: 'gpt-4o',
  vlmBaseUrl: 'https://api.openai.com/v1'
};

// 连接状态
let ws = null;
let isConnected = false;
let reconnectTimer = null;

// 受控窗口状态 (持久化到 storage，防止 Service Worker 重启丢失)
let controlledWindowId = null;

// 主窗口状态 (关闭预览时恢复)
let mainWindowId = null;
let mainWindowOriginalBounds = null;

// 预览窗口尺寸 (右侧小窗，类似画中画)
const PREVIEW_WIDTH_RATIO = 0.38;   // 屏幕宽度的 38%
const PREVIEW_HEIGHT_RATIO = 0.75;  // 屏幕高度的 75%

// ============ 屏幕和视口工具 ============

/**
 * 获取主显示器工作区尺寸
 */
async function getScreenDimensions() {
  try {
    const displays = await chrome.system.display.getInfo();
    var primary = null;
    for (var i = 0; i < displays.length; i++) {
      if (displays[i].isPrimary) { primary = displays[i]; break; }
    }
    if (!primary) primary = displays[0];
    return {
      width: primary.workArea.width,
      height: primary.workArea.height,
      left: primary.workArea.left,
      top: primary.workArea.top
    };
  } catch (e) {
    console.error('Failed to get display info:', e);
    return { width: 1920, height: 1080, left: 0, top: 0 };
  }
}

/**
 * 获取标签页的视口信息 (用于 VLM 坐标映射)
 */
async function getViewportInfo(tabId) {
  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function() {
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1
        };
      }
    });
    return (results[0] && results[0].result) || { width: 1024, height: 768, dpr: 1 };
  } catch (e) {
    console.warn('Failed to get viewport info:', e);
    return { width: 1024, height: 768, dpr: 1 };
  }
}

// ============ 配置管理 ============

async function loadConfig() {
  const result = await chrome.storage.local.get([
    'serverUrl', 'userId', 'vlmApiKey', 'vlmModel', 'vlmBaseUrl',
    'controlledWindowId'
  ]);
  if (result.serverUrl) config.serverUrl = result.serverUrl;
  if (result.userId) config.userId = result.userId;
  if (result.vlmApiKey) config.vlmApiKey = result.vlmApiKey;
  if (result.vlmModel) config.vlmModel = result.vlmModel;
  if (result.vlmBaseUrl) config.vlmBaseUrl = result.vlmBaseUrl;
  // 恢复受控窗口 ID
  if (result.controlledWindowId) controlledWindowId = result.controlledWindowId;
  return config;
}

async function saveConfig(newConfig) {
  Object.assign(config, newConfig);
  await chrome.storage.local.set(config);
}

// ============ WebSocket 连接 ============

function connect() {
  if (!config.serverUrl || !config.userId) {
    console.log('Missing server URL or user ID');
    return;
  }

  if (ws) {
    try { ws.close(); } catch (e) {}
  }

  let wsUrl = config.serverUrl;
  if (wsUrl.startsWith('http://')) {
    wsUrl = 'ws://' + wsUrl.substring(7);
  } else if (wsUrl.startsWith('https://')) {
    wsUrl = 'wss://' + wsUrl.substring(8);
  }
  if (!wsUrl.includes('/browser-mcp/ws/')) {
    wsUrl = wsUrl.replace(/\/$/, '') + '/browser-mcp/ws/' + config.userId;
  }

  console.log('Connecting to:', wsUrl);

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
      console.log('WebSocket connected');
      ws.send(JSON.stringify({
        type: 'register',
        browser_info: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language
        }
      }));
    };

    ws.onmessage = async function(event) {
      try {
        const message = JSON.parse(event.data);
        await handleMessage(message);
      } catch (e) {
        console.error('Error handling message:', e);
      }
    };

    ws.onclose = function() {
      console.log('WebSocket disconnected');
      isConnected = false;
      stopHeartbeat();
      updateBadge('disconnected');

      if (!reconnectTimer) {
        reconnectTimer = setTimeout(function() {
          reconnectTimer = null;
          connect();
        }, 5000);
      }
    };

    ws.onerror = function(error) {
      console.error('WebSocket error:', error);
      if (connectPromiseReject) {
        connectPromiseReject(new Error('WebSocket connection failed'));
        connectPromiseResolve = null;
        connectPromiseReject = null;
      }
    };

  } catch (error) {
    console.error('Failed to connect:', error);
    updateBadge('error');
  }
}

// ============ 消息处理 ============

async function handleMessage(message) {
  console.log('Received:', message);

  if (message.type === 'registered') {
    isConnected = true;
    startHeartbeat();
    updateBadge('connected');
    console.log('Successfully registered');

    if (connectPromiseResolve) {
      connectPromiseResolve();
      connectPromiseResolve = null;
      connectPromiseReject = null;
    }
  }
  else if (message.type === 'command') {
    const { request_id, action, params } = message;
    try {
      const result = await executeAction(action, params);
      ws.send(JSON.stringify({
        type: 'response',
        request_id: request_id,
        data: result
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'response',
        request_id: request_id,
        error: error.message
      }));
    }
  }
  else if (message.type === 'heartbeat_ack') {
    // 心跳确认
  }
}

// ============ 受控窗口管理 ============

/**
 * 确保受控窗口存在，不存在则创建一个
 * - 校验窗口类型为 popup，防止误用主浏览器窗口
 * - 画中画布局：主窗口缩小腾出空间，预览窗口放右上角
 * - 持久化 windowId 到 storage，防止 Service Worker 重启丢失
 */
async function ensureControlledWindow() {
  // 检查窗口是否还存在，且必须是 popup 类型（防止误用主浏览器窗口）
  if (controlledWindowId) {
    try {
      var win = await chrome.windows.get(controlledWindowId);
      if (win.type !== 'popup') {
        console.warn('[Window] Stored window is type=' + win.type + ', not popup. Recreating.');
        controlledWindowId = null;
        await chrome.storage.local.set({ controlledWindowId: null });
      } else {
        if (win.state === 'minimized') {
          await chrome.windows.update(controlledWindowId, { state: 'normal' });
        }
        return;
      }
    } catch (e) {
      controlledWindowId = null;
      await chrome.storage.local.set({ controlledWindowId: null });
    }
  }

  // 获取屏幕尺寸
  var screen = await getScreenDimensions();
  var previewW = Math.round(screen.width * PREVIEW_WIDTH_RATIO);
  var previewH = Math.round(screen.height * PREVIEW_HEIGHT_RATIO);
  console.log('Screen:', screen.width + 'x' + screen.height, 'Preview:', previewW + 'x' + previewH);

  // 预览窗口放右上角（不缩小主窗口，避免侵入用户布局）
  var left = screen.left + screen.width - previewW;
  var top = screen.top;

  // 带品牌感的初始等待页（渐变背景 + 呼吸动画）
  var initPage = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<html><head><meta charset="utf-8"><style>'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{display:flex;align-items:center;justify-content:center;height:100vh;'
    + 'background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);'
    + 'font-family:system-ui,-apple-system,sans-serif;overflow:hidden}'
    + '.wrap{text-align:center;color:rgba(255,255,255,0.85)}'
    + '.icon{font-size:48px;animation:pulse 2s ease-in-out infinite}'
    + '.title{font-size:18px;font-weight:600;margin:16px 0 6px;letter-spacing:1px}'
    + '.sub{font-size:13px;color:rgba(255,255,255,0.5)}'
    + '.dots{margin-top:24px;display:flex;justify-content:center;gap:6px}'
    + '.dots span{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.3);'
    + 'animation:dot 1.4s ease-in-out infinite}'
    + '.dots span:nth-child(2){animation-delay:0.2s}'
    + '.dots span:nth-child(3){animation-delay:0.4s}'
    + '@keyframes pulse{0%,100%{transform:scale(1);opacity:0.8}50%{transform:scale(1.1);opacity:1}}'
    + '@keyframes dot{0%,80%,100%{opacity:0.3;transform:scale(1)}40%{opacity:1;transform:scale(1.3)}}'
    + '</style></head><body>'
    + '<div class="wrap">'
    + '<div class="icon">\uD83E\uDD16</div>'
    + '<div class="title">Browser MCP</div>'
    + '<div class="sub">AI \u53D7\u63A7\u6D4F\u89C8\u5668 \u00B7 \u7B49\u5F85\u6307\u4EE4</div>'
    + '<div class="dots"><span></span><span></span><span></span></div>'
    + '</div></body></html>'
  );

  var newWin = await chrome.windows.create({
    url: initPage,
    type: 'popup',
    width: previewW,
    height: previewH,
    left: left,
    top: top,
    focused: false
  });

  controlledWindowId = newWin.id;
  await chrome.storage.local.set({ controlledWindowId: newWin.id });
  console.log('[Window] Preview created:', controlledWindowId, previewW + 'x' + previewH, 'at', left + ',' + top);
}

/**
 * 恢复主窗口原始尺寸 (关闭预览窗时调用)
 */
async function restoreMainWindow() {
  if (!mainWindowId || !mainWindowOriginalBounds) return;
  try {
    var b = mainWindowOriginalBounds;
    if (b.state === 'maximized' || b.state === 'fullscreen') {
      await chrome.windows.update(mainWindowId, { state: b.state });
    } else {
      await chrome.windows.update(mainWindowId, {
        left: b.left, top: b.top,
        width: b.width, height: b.height
      });
    }
    console.log('[Window] Main window restored');
  } catch (e) {
    console.warn('[Window] Failed to restore main window:', e);
  }
  mainWindowId = null;
  mainWindowOriginalBounds = null;
}

/**
 * 获取受控窗口中的活跃标签页
 */
async function getControlledTab() {
  await ensureControlledWindow();

  const tabs = await chrome.tabs.query({ windowId: controlledWindowId, active: true });
  if (tabs.length > 0) return tabs[0];

  // 如果没有活跃标签页，获取任意标签页
  const allTabs = await chrome.tabs.query({ windowId: controlledWindowId });
  if (allTabs.length > 0) return allTabs[0];

  // 如果没有标签页，创建一个
  const tab = await chrome.tabs.create({ windowId: controlledWindowId, url: 'about:blank' });
  return tab;
}

// 监听受控窗口被关闭 → 恢复主窗口
chrome.windows.onRemoved.addListener(function(windowId) {
  if (windowId === controlledWindowId) {
    controlledWindowId = null;
    chrome.storage.local.set({ controlledWindowId: null });
    restoreMainWindow();
    console.log('Controlled window closed by user');
  }
});

// 拦截从受控窗口打开的新标签页 (target="_blank", window.open 等)
// 这些标签页会默认打开在主浏览器窗口，需要移回受控窗口
// 标记：当受控窗口正在执行操作时设为 true，此期间新打开的标签页都移回受控窗口
let _controlledWindowBusy = false;

chrome.tabs.onCreated.addListener(async function(tab) {
  if (!controlledWindowId) return;
  if (tab.windowId === controlledWindowId) return; // 已经在受控窗口

  var shouldMove = false;

  // 方式1：有 openerTabId，检查是否来自受控窗口
  if (tab.openerTabId) {
    try {
      var openerTab = await chrome.tabs.get(tab.openerTabId);
      if (openerTab.windowId === controlledWindowId) {
        shouldMove = true;
      }
    } catch (e) {}
  }

  // 方式2：受控窗口正在执行操作时，新标签页大概率是操作触发的
  if (!shouldMove && _controlledWindowBusy) {
    shouldMove = true;
  }

  if (shouldMove) {
    try {
      await chrome.tabs.move(tab.id, { windowId: controlledWindowId, index: -1 });
      await chrome.tabs.update(tab.id, { active: true });
      console.log('[Tab] Intercepted new tab, moved to controlled window:', tab.id, tab.pendingUrl || tab.url);
    } catch (e) {
      console.warn('[Tab] Failed to intercept tab:', e);
    }
  }
});

// ============ 动作调度 ============

async function executeAction(action, params) {
  console.log('Executing action:', action, params);

  switch (action) {
    case 'browser_navigate':
      return await actionNavigate(params);
    case 'browser_click':
      return await actionClick(params);
    case 'browser_type':
      return await actionType(params);
    case 'browser_screenshot':
      return await actionScreenshot(params);
    case 'browser_get_content':
      return await actionGetContent(params);
    case 'browser_scroll':
      return await actionScroll(params);
    case 'browser_get_tabs':
      return await actionGetTabs();
    case 'browser_switch_tab':
      return await actionSwitchTab(params);
    case 'browser_new_tab':
      return await actionNewTab(params);
    case 'browser_close_tab':
      return await actionCloseTab(params);
    default:
      throw new Error('Unknown action: ' + action);
  }
}

// 在受控窗口的标签页中执行脚本
async function executeScript(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: func,
    args: args || []
  });
  return results[0] ? results[0].result : null;
}

// ============ 页面快照 ============

/**
 * 构建页面快照：提取可交互元素列表，标记 data-mcp-ref
 * 每个改变页面的操作都返回快照，让 Agent 看到页面状态
 */
async function buildPageSnapshot(tabId) {
  var domInfo = await executeScript(tabId, function() {
    // 清除旧标记
    document.querySelectorAll('[data-mcp-ref]').forEach(function(el) {
      el.removeAttribute('data-mcp-ref');
    });

    var info = {
      title: document.title,
      url: location.href,
      scrollY: Math.round(window.scrollY),
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight
    };

    // 收集可见的可交互元素
    var elements = [];
    var selectors = 'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[onclick]';
    var all = document.querySelectorAll(selectors);
    var refIndex = 0;

    for (var i = 0; i < all.length && refIndex < 50; i++) {
      var el = all[i];
      // 跳过不可见元素
      if (el.offsetParent === null && el.tagName !== 'BODY') continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;
      // 跳过视口外的元素
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

      el.setAttribute('data-mcp-ref', refIndex);

      var item = {
        ref: refIndex,
        tag: el.tagName.toLowerCase(),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
      };

      // 根据标签类型添加属性
      var tag = el.tagName;
      if (tag === 'A') {
        item.text = (el.textContent || '').trim().substring(0, 60);
        item.href = (el.href || '').substring(0, 120);
      }
      if (tag === 'BUTTON' || el.getAttribute('role') === 'button') {
        item.text = (el.textContent || '').trim().substring(0, 60);
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        item.type = el.type || 'text';
        item.placeholder = el.placeholder || '';
        item.value = (el.value || '').substring(0, 50);
        item.name = el.name || '';
      }
      if (tag === 'SELECT') {
        item.name = el.name || '';
        var selected = el.options[el.selectedIndex];
        item.selectedText = selected ? selected.text : '';
      }

      elements.push(item);
      refIndex++;
    }

    info.elements = elements;

    // 注入/更新持久标题栏（蓝紫渐变）
    var header = document.getElementById('_mcp_header');
    if (!header) {
      header = document.createElement('div');
      header.id = '_mcp_header';
      header.style.cssText = 'position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483646;'
        + 'background:linear-gradient(90deg,#667eea,#764ba2);color:#fff;'
        + 'display:flex;align-items:center;padding:0 12px;font:12px/28px system-ui,sans-serif;'
        + 'box-shadow:0 1px 4px rgba(0,0,0,0.2);user-select:none;';
      document.body.appendChild(header);
      // body 补偿 padding，避免遮挡页面内容
      var currentPadding = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
      document.body.style.paddingTop = (currentPadding + 28) + 'px';
    }
    // 安全构建标题栏内容（不用 innerHTML）
    while (header.firstChild) header.removeChild(header.firstChild);
    var iconSpan = document.createElement('span');
    iconSpan.textContent = '\uD83E\uDD16';
    iconSpan.style.marginRight = '8px';
    header.appendChild(iconSpan);
    var nameSpan = document.createElement('span');
    nameSpan.textContent = 'Browser MCP';
    nameSpan.style.cssText = 'font-weight:600;margin-right:8px';
    header.appendChild(nameSpan);
    var domainSpan = document.createElement('span');
    domainSpan.textContent = location.hostname || location.href.substring(0, 30);
    domainSpan.style.cssText = 'opacity:0.7;font-size:11px';
    header.appendChild(domainSpan);

    return info;
  });

  // 组装快照
  var snapshot = {
    success: true,
    page: {
      title: domInfo.title,
      url: domInfo.url,
      scrollY: domInfo.scrollY,
      pageHeight: domInfo.pageHeight,
      viewportHeight: domInfo.viewportHeight
    },
    elements: domInfo.elements
  };

  // VLM 页面视觉描述 (可选)
  if (config.vlmApiKey) {
    try {
      var dataUrl = await captureScreenshot();
      snapshot.vlmDescription = await describePageWithVLM(dataUrl);
    } catch (e) {
      console.warn('[Snapshot] VLM description failed:', e.message);
    }
  }

  return snapshot;
}

// ============ 操作状态浮层 ============

/**
 * 在预览窗口页面顶部显示当前操作状态
 */
async function showActionOverlay(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function(msg) {
        var el = document.getElementById('_mcp_overlay');
        if (!el) {
          el = document.createElement('div');
          el.id = '_mcp_overlay';
          el.style.cssText = 'position:fixed;bottom:16px;left:50%;z-index:2147483647;'
            + 'transform:translateX(-50%) translateY(10px);'
            + 'background:rgba(0,0,0,0.75);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);'
            + 'color:#fff;padding:8px 20px;border-radius:20px;'
            + 'font:13px/1.4 system-ui,sans-serif;white-space:nowrap;'
            + 'pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.3);'
            + 'opacity:0;transition:all 0.3s ease;';
          document.body.appendChild(el);
          // 触发进场动画 (slide up + fade in)
          requestAnimationFrame(function() {
            el.style.opacity = '1';
            el.style.transform = 'translateX(-50%) translateY(0)';
          });
        } else {
          el.style.opacity = '1';
          el.style.transform = 'translateX(-50%) translateY(0)';
        }
        el.textContent = msg;
      },
      args: [text]
    });
  } catch (e) {
    // 页面可能还在加载，忽略
  }
}

/**
 * 隐藏操作状态浮层
 */
async function hideActionOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function() {
        var el = document.getElementById('_mcp_overlay');
        if (el) {
          el.style.opacity = '0';
          el.style.transform = 'translateX(-50%) translateY(10px)';
          setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
        }
      }
    });
  } catch (e) {}
}

// ============ 动作实现 (所有操作在受控窗口中执行) ============

async function actionNavigate(params) {
  var url = params.url;
  var tab = await getControlledTab();

  await showActionOverlay(tab.id, '🌐 正在打开 ' + url + ' ...');
  await chrome.tabs.update(tab.id, { url: url });

  // 等待页面加载完成
  await new Promise(function(resolve) {
    function listener(tabId, changeInfo) {
      if (tabId === tab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(function() { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
  });

  hideActionOverlay(tab.id);
  // 等待页面 JS 渲染完成
  await new Promise(function(r) { setTimeout(r, 500); });

  var snapshot = await buildPageSnapshot(tab.id);
  snapshot.action = 'navigate';
  snapshot.navigatedTo = url;
  return snapshot;
}

async function actionClick(params) {
  var ref = params.ref;
  var tab = await getControlledTab();
  _controlledWindowBusy = true;

  await showActionOverlay(tab.id, '👆 正在点击元素 ref=' + ref + ' ...');

  var clickResult = await executeScript(tab.id, function(refId) {
    var el = document.querySelector('[data-mcp-ref="' + refId + '"]');
    if (!el) return { success: false, error: 'Element ref=' + refId + ' not found. Page may have changed, use browser_screenshot to get fresh element list.' };

    // 如果是 <a> 链接，强制在当前窗口打开（防止 target="_blank" 在主浏览器打开新标签页）
    var savedTarget = null;
    if (el.tagName === 'A' && el.target && el.target !== '_self') {
      savedTarget = el.target;
      el.target = '_self';
    }

    el.click();

    // 恢复原始 target（防止影响页面后续行为）
    if (savedTarget !== null) {
      el.target = savedTarget;
    }

    return { success: true, tagName: el.tagName, text: (el.textContent || '').trim().substring(0, 60) };
  }, [ref]);

  if (!clickResult || clickResult.success === false) {
    hideActionOverlay(tab.id);
    _controlledWindowBusy = false;
    var snapshot = await buildPageSnapshot(tab.id);
    snapshot.action = 'click';
    snapshot.error = clickResult ? clickResult.error : 'Click failed';
    return snapshot;
  }

  // 等待可能的页面导航
  await new Promise(function(r) { setTimeout(r, 800); });
  hideActionOverlay(tab.id);
  _controlledWindowBusy = false;

  var snapshot = await buildPageSnapshot(tab.id);
  snapshot.action = 'click';
  snapshot.clicked = { ref: ref, tagName: clickResult.tagName, text: clickResult.text };
  return snapshot;
}

async function actionType(params) {
  var ref = params.ref;
  var text = params.text;
  var shouldSubmit = params.submit || false;
  var tab = await getControlledTab();

  var overlayMsg = '⌨️ 正在输入 "' + text + '"';
  if (shouldSubmit) overlayMsg += ' 并提交';
  await showActionOverlay(tab.id, overlayMsg + ' ...');

  var typeResult = await executeScript(tab.id, function(refId, txt, submit) {
    var el = document.querySelector('[data-mcp-ref="' + refId + '"]');
    if (!el) return { success: false, error: 'Element ref=' + refId + ' not found. Use browser_screenshot to refresh.' };

    // 检查是否是可输入元素
    var isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    if (!isInput) return { success: false, error: 'Element ref=' + refId + ' is <' + el.tagName + '>, not an input. Pick a different ref.' };

    el.focus();
    // React/Vue 兼容的值设置 - 支持 INPUT 和 TEXTAREA
    var proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var ns = Object.getOwnPropertyDescriptor(proto, 'value');
    if (ns && ns.set) {
      ns.set.call(el, txt);
    } else {
      el.value = txt;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      var form = el.closest('form');
      if (form) form.submit();
    }

    return { success: true, tagName: el.tagName, placeholder: el.placeholder || '' };
  }, [ref, text, shouldSubmit]);

  if (!typeResult || typeResult.success === false) {
    hideActionOverlay(tab.id);
    var snapshot = await buildPageSnapshot(tab.id);
    snapshot.action = 'type';
    snapshot.error = typeResult ? typeResult.error : 'Type failed';
    return snapshot;
  }

  // submit 时等待页面导航
  if (shouldSubmit) {
    await new Promise(function(resolve) {
      var resolved = false;
      function listener(tabId, changeInfo) {
        if (tabId === tab.id && changeInfo.status === 'complete' && !resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(function() {
        if (!resolved) { resolved = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); }
      }, 5000);
    });
    await new Promise(function(r) { setTimeout(r, 500); });
  }

  hideActionOverlay(tab.id);
  var snapshot = await buildPageSnapshot(tab.id);
  snapshot.action = 'type';
  snapshot.typed = { ref: ref, text: text, submitted: shouldSubmit };
  return snapshot;
}

async function actionScreenshot() {
  var tab = await getControlledTab();
  await showActionOverlay(tab.id, '📸 正在分析页面 ...');
  var snapshot = await buildPageSnapshot(tab.id);
  snapshot.action = 'snapshot';
  hideActionOverlay(tab.id);
  return snapshot;
}

async function captureScreenshot() {
  await ensureControlledWindow();

  // 确保窗口未最小化即可，不抢焦点（避免窗口跳动）
  try {
    var win = await chrome.windows.get(controlledWindowId);
    if (win.state === 'minimized') {
      await chrome.windows.update(controlledWindowId, { state: 'normal' });
      await new Promise(function(r) { setTimeout(r, 200); });
    }
  } catch (e) {}

  return await chrome.tabs.captureVisibleTab(controlledWindowId, { format: 'png' });
}

async function actionGetContent(params) {
  const format = params.format || 'text';
  const tab = await getControlledTab();

  await showActionOverlay(tab.id, '📖 正在读取页面内容 ...');
  var result = await executeScript(tab.id, function(fmt) {
    if (fmt === 'html') {
      return { success: true, content: document.documentElement.outerHTML };
    }
    if (fmt === 'markdown') {
      return { success: true, content: '# ' + document.title + '\n\n' + document.body.innerText };
    }
    return { success: true, content: document.body.innerText };
  }, [format]);
  hideActionOverlay(tab.id);
  return result;
}

async function actionScroll(params) {
  var direction = params.direction;
  var amount = params.amount || 500;
  var tab = await getControlledTab();

  var dirText = direction === 'down' ? '向下' : '向上';
  await showActionOverlay(tab.id, '📜 正在' + dirText + '滚动 ...');
  await executeScript(tab.id, function(dir, amt) {
    var y = dir === 'down' ? amt : -amt;
    window.scrollBy({ top: y, behavior: 'smooth' });
  }, [direction, amount]);

  // 等待滚动动画完成
  await new Promise(function(r) { setTimeout(r, 500); });
  hideActionOverlay(tab.id);

  var snapshot = await buildPageSnapshot(tab.id);
  snapshot.action = 'scroll';
  snapshot.scrolled = { direction: direction, amount: amount };
  return snapshot;
}

async function actionGetTabs() {
  await ensureControlledWindow();
  const tabs = await chrome.tabs.query({ windowId: controlledWindowId });
  return {
    success: true,
    tabs: tabs.map(function(tab) {
      return {
        id: tab.id,
        index: tab.index,
        url: tab.url,
        title: tab.title,
        active: tab.active
      };
    })
  };
}

async function actionSwitchTab(params) {
  await ensureControlledWindow();

  if (params.index !== undefined) {
    const tabs = await chrome.tabs.query({ windowId: controlledWindowId });
    const tab = tabs[params.index];
    if (!tab) throw new Error('Tab not found at index: ' + params.index);
    await chrome.tabs.update(tab.id, { active: true });
    return { success: true, tabId: tab.id };
  }

  if (params.url) {
    const tabs = await chrome.tabs.query({ windowId: controlledWindowId });
    const tab = tabs.find(function(t) { return t.url && t.url.includes(params.url); });
    if (!tab) throw new Error('Tab not found with URL: ' + params.url);
    await chrome.tabs.update(tab.id, { active: true });
    return { success: true, tabId: tab.id };
  }

  throw new Error('Must specify index or url');
}

async function actionNewTab(params) {
  await ensureControlledWindow();
  const url = params.url || 'about:blank';
  const tab = await chrome.tabs.create({ windowId: controlledWindowId, url: url, active: true });
  return { success: true, tabId: tab.id, url: url };
}

async function actionCloseTab(params) {
  await ensureControlledWindow();

  if (params.index !== undefined) {
    const tabs = await chrome.tabs.query({ windowId: controlledWindowId });
    const tab = tabs[params.index];
    if (!tab) throw new Error('Tab not found');
    await chrome.tabs.remove(tab.id);
    return { success: true, closedTabId: tab.id };
  }

  const tab = await getControlledTab();
  await chrome.tabs.remove(tab.id);
  return { success: true, closedTabId: tab.id };
}

// ============ VLM 页面描述 ============

/**
 * 使用 VLM 视觉模型描述页面内容（不定位元素）
 * 用于快照的 vlmDescription 字段，帮助 Agent 理解页面视觉状态
 */
async function describePageWithVLM(screenshotDataUrl) {
  var prompt = '请用中文简要描述这个网页截图：\n'
    + '1. 这是什么网站/页面\n'
    + '2. 页面当前展示了什么内容（搜索结果？文章？首页？）\n'
    + '3. 有哪些关键的可交互区域\n'
    + '用 3-5 句话概括。';

  var response = await fetch(config.vlmBaseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.vlmApiKey
    },
    body: JSON.stringify({
      model: config.vlmModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: screenshotDataUrl } }
        ]
      }],
      max_tokens: 300
    })
  });

  var data = await response.json();
  if (data.choices && data.choices[0]) {
    return data.choices[0].message.content;
  }
  throw new Error('Invalid VLM response');
}

// ============ 心跳保活 (chrome.alarms) ============

function startHeartbeat() {
  stopHeartbeat();
  chrome.alarms.create('browser-mcp-keepalive', { periodInMinutes: 0.4 });
}

function stopHeartbeat() {
  chrome.alarms.clear('browser-mcp-keepalive');
}

chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === 'browser-mcp-keepalive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }));
      console.log('Heartbeat sent');
    } else if (isConnected) {
      console.log('WebSocket dead, reconnecting...');
      isConnected = false;
      connect();
    }
  }
});

// ============ Badge 状态 ============

function updateBadge(status) {
  const colors = {
    connected: '#4CAF50',
    disconnected: '#9E9E9E',
    error: '#F44336'
  };
  const texts = {
    connected: 'ON',
    disconnected: 'OFF',
    error: 'ERR'
  };

  chrome.action.setBadgeBackgroundColor({ color: colors[status] || '#9E9E9E' });
  chrome.action.setBadgeText({ text: texts[status] || '' });
}

// ============ Popup 消息处理 ============

let connectPromiseResolve = null;
let connectPromiseReject = null;

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'get_status') {
    // 异步检查受控窗口是否存在
    (async function() {
      let panelOpen = false;
      if (controlledWindowId) {
        try {
          await chrome.windows.get(controlledWindowId);
          panelOpen = true;
        } catch (e) {
          controlledWindowId = null;
          chrome.storage.local.set({ controlledWindowId: null });
        }
      }
      sendResponse({
        connected: isConnected,
        config: config,
        panelOpen: panelOpen
      });
    })();
    return true;
  }
  else if (message.type === 'connect') {
    saveConfig(message.config).then(function() {
      const connectPromise = new Promise(function(resolve, reject) {
        connectPromiseResolve = resolve;
        connectPromiseReject = reject;

        setTimeout(function() {
          if (connectPromiseReject) {
            connectPromiseReject(new Error('Connection timeout'));
            connectPromiseResolve = null;
            connectPromiseReject = null;
          }
        }, 10000);
      });

      connect();

      connectPromise
        .then(function() {
          sendResponse({ success: true });
        })
        .catch(function(error) {
          sendResponse({ success: false, error: error.message });
        });
    });
    return true;
  }
  else if (message.type === 'disconnect') {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) ws.close();
    isConnected = false;
    sendResponse({ success: true });
  }
  else if (message.type === 'open_panel') {
    ensureControlledWindow().then(function() {
      chrome.windows.update(controlledWindowId, { focused: true });
      sendResponse({ success: true });
    }).catch(function(error) {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  else if (message.type === 'close_panel') {
    if (controlledWindowId) {
      chrome.windows.remove(controlledWindowId).then(function() {
        controlledWindowId = null;
        chrome.storage.local.set({ controlledWindowId: null });
        restoreMainWindow();
        sendResponse({ success: true });
      }).catch(function(error) {
        controlledWindowId = null;
        chrome.storage.local.set({ controlledWindowId: null });
        restoreMainWindow();
        sendResponse({ success: false, error: error.message });
      });
    } else {
      sendResponse({ success: true });
    }
    return true;
  }
  return true;
});

// ============ 初始化 ============

loadConfig().then(function() {
  if (config.serverUrl && config.userId) {
    connect();
  }
});

console.log('Browser MCP Agent background script loaded');
