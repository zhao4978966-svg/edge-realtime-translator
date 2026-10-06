/* =========================================================================
 * background.js —— MV3 Service Worker
 * 负责：右键菜单、把 popup 的操作转发到当前标签页、快捷键命令
 * ========================================================================= */

const DEFAULTS = {
  autoTranslate: true,
  targetLang: 'zh-CN',
  engine: 'deepseek',
  overlayEnabled: true,
  floatingButton: true,
};

const MENU_TRANSLATE_PAGE = 'dsh-translate-page';
const MENU_RESTORE_PAGE = 'dsh-restore-page';
const MENU_TRANSLATE_SELECTION = 'dsh-translate-selection';

function createMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_SELECTION,
      title: '翻译选中文字：“%s”',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_PAGE,
      title: '翻译整个页面',
      contexts: ['page', 'frame'],
    });
    chrome.contextMenus.create({
      id: MENU_RESTORE_PAGE,
      title: '还原为原文',
      contexts: ['page', 'frame'],
    });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  createMenus();
  chrome.storage.local.get(DEFAULTS, function (stored) {
    const patch = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      if (stored == null || stored[key] === undefined) patch[key] = DEFAULTS[key];
    });
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
  if (details && details.reason === 'install') {
    console.log('[实时网页翻译] 安装完成：请点击工具栏图标设置翻译引擎与目标语言。');
  }
});

chrome.runtime.onStartup.addListener(createMenus);

/* --------------------------- 与标签页通信的封装 --------------------------- */

function sendToTab(tabId, message) {
  return new Promise(function (resolve) {
    if (tabId == null || tabId < 0) {
      resolve({ ok: false, error: '当前页面不支持翻译' });
      return;
    }
    chrome.tabs.sendMessage(tabId, message, function (response) {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: true });
    });
  });
}

/**
 * 优先发消息；如果内容脚本未注入（例如扩展安装后才打开的标签页需要刷新），
 * 则动态注入一次再重试。
 */
async function sendWithInject(tabId, message) {
  let response = await sendToTab(tabId, message);
  if (response && response.ok) return response;
  if (!response || !/Receiving end does not exist|Could not establish connection/i.test(response.error || '')) {
    return response;
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['lib/content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['lib/translator.js', 'lib/content.js'],
    });
  } catch (err) {
    return { ok: false, error: '无法注入翻译脚本：' + (err && err.message ? err.message : String(err)) };
  }
  await new Promise(function (resolve) { setTimeout(resolve, 250); });
  return sendToTab(tabId, message);
}

/* ------------------------------- 右键菜单 ------------------------------- */

chrome.contextMenus.onClicked.addListener(async function (info, tab) {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_TRANSLATE_SELECTION) {
    await sendWithInject(tab.id, {
      type: 'DSH_TRANSLATE_SELECTION',
      text: info.selectionText || '',
      showCard: true,
    });
    return;
  }
  if (info.menuItemId === MENU_TRANSLATE_PAGE) {
    await sendWithInject(tab.id, { type: 'DSH_TRANSLATE_PAGE' });
    return;
  }
  if (info.menuItemId === MENU_RESTORE_PAGE) {
    await sendWithInject(tab.id, { type: 'DSH_RESTORE' });
  }
});

/* --------------------------- 来自 popup 的消息 --------------------------- */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return false;

  if (message.type === 'DSH_TAB_ACTION') {
    (async function () {
      const tabId = message.tabId;
      if (message.action === 'translate') {
        return sendWithInject(tabId, { type: 'DSH_SET_ENABLED', enabled: true, target: message.target });
      }
      if (message.action === 'restore') {
        return sendWithInject(tabId, { type: 'DSH_RESTORE' });
      }
      if (message.action === 'translate-selection') {
        return sendWithInject(tabId, {
          type: 'DSH_TRANSLATE_SELECTION',
          text: message.text || '',
          showCard: true,
        });
      }
      if (message.action === 'overlay') {
        return sendWithInject(tabId, { type: 'DSH_TOGGLE_OVERLAY', enabled: !!message.enabled });
      }
      return { ok: false, error: '未知操作：' + message.action };
    })()
      .then(function (result) { sendResponse(result); })
      .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
    return true;
  }

  if (message.type === 'DSH_SETTINGS_CHANGED') {
    // 广播给所有标签页：更新目标语言并在需要时重新翻译
    chrome.tabs.query({}, function (tabs) {
      (tabs || []).forEach(function (tab) {
        if (tab.id == null) return;
        sendToTab(tab.id, { type: 'DSH_SETTINGS_CHANGED' });
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/* ------------------------------- 快捷键命令 ------------------------------ */

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async function (command) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    if (command === 'toggle-translate') {
      const status = await sendWithInject(tab.id, { type: 'DSH_STATUS' });
      await sendWithInject(tab.id, status && status.active
        ? { type: 'DSH_RESTORE' }
        : { type: 'DSH_SET_ENABLED', enabled: true });
    }
  });
}
