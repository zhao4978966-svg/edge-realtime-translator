/* =========================================================================
 * popup/popup.js —— 设置与快捷操作面板
 * ========================================================================= */
(function () {
  'use strict';

  const T = window.DSHTranslate;

  const el = {
    pageHint: document.getElementById('pageHint'),
    status: document.getElementById('status'),
    targetLang: document.getElementById('targetLang'),
    engine: document.getElementById('engine'),
    autoTranslate: document.getElementById('autoTranslate'),
    overlayEnabled: document.getElementById('overlayEnabled'),
    debug: document.getElementById('debug'),
    deepseekCard: document.getElementById('deepseekCard'),
    apiKey: document.getElementById('apiKey'),
    apiBase: document.getElementById('apiBase'),
    model: document.getElementById('model'),
    translateBtn: document.getElementById('translateBtn'),
    restoreBtn: document.getElementById('restoreBtn'),
    selBtn: document.getElementById('selBtn'),
    testBtn: document.getElementById('testBtn'),
  };

  let currentTab = null;
  let settings = Object.assign({}, T.DEFAULTS);
  let saveTimer = null;

  function setStatus(text, kind) {
    el.status.textContent = text || '';
    el.status.setAttribute('data-kind', kind || '');
  }

  function fillLanguages() {
    el.targetLang.innerHTML = '';
    T.LANGUAGE_OPTIONS.forEach(function (item) {
      const option = document.createElement('option');
      option.value = item.code;
      option.textContent = item.name;
      el.targetLang.appendChild(option);
    });
  }

  function renderSettings() {
    el.targetLang.value = T.normalizeLang(settings.targetLang);
    el.engine.value = settings.engine === T.ENGINE_GOOGLE ? T.ENGINE_GOOGLE : T.ENGINE_DEEPSEEK;
    el.autoTranslate.checked = settings.autoTranslate !== false;
    el.overlayEnabled.checked = settings.overlayEnabled !== false;
    el.debug.checked = settings.debug === true;
    el.apiKey.value = settings.apiKey || '';
    el.apiBase.value = settings.apiBase || T.DEFAULTS.apiBase;
    el.model.value = settings.model || T.DEFAULTS.model;
    syncEngineVisibility();
  }

  function syncEngineVisibility() {
    const isDeepSeek = el.engine.value !== T.ENGINE_GOOGLE;
    el.deepseekCard.style.display = isDeepSeek ? '' : 'none';
  }

  function collectSettings() {
    return {
      targetLang: T.normalizeLang(el.targetLang.value),
      engine: el.engine.value,
      autoTranslate: el.autoTranslate.checked,
      overlayEnabled: el.overlayEnabled.checked,
      debug: el.debug.checked,
      apiKey: el.apiKey.value.trim(),
      apiBase: el.apiBase.value.trim() || T.DEFAULTS.apiBase,
      model: el.model.value.trim() || T.DEFAULTS.model,
    };
  }

  /** 去抖保存，避免每敲一个字符就写一次 storage */
  function scheduleSave(options) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async function () {
      saveTimer = null;
      const patch = collectSettings();
      settings = Object.assign(settings, patch);
      await T.saveSettings(patch);
      if (!options || options.broadcast !== false) {
        chrome.runtime.sendMessage({ type: 'DSH_SETTINGS_CHANGED' });
      }
      if (options && options.notice) setStatus(options.notice, 'ok');
    }, options && options.immediate ? 0 : 400);
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  function tabIsTranslatable(tab) {
    if (!tab || !tab.url) return false;
    return /^https?:\/\//i.test(tab.url);
  }

  async function refreshPageStatus() {
    currentTab = await getActiveTab();
    const translatable = tabIsTranslatable(currentTab);
    if (!translatable) {
      el.pageHint.textContent = '当前页面不支持翻译（浏览器内部页面）';
      el.translateBtn.disabled = true;
      el.restoreBtn.disabled = true;
      el.selBtn.disabled = true;
      return;
    }
    let host = currentTab.url;
    try {
      host = new URL(currentTab.url).hostname;
    } catch (err) { /* 保留原值 */ }
    el.pageHint.textContent = host;

    const status = await new Promise(function (resolve) {
      chrome.tabs.sendMessage(currentTab.id, { type: 'DSH_STATUS' }, function (response) {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response || null);
      });
    });

    if (status && status.active) {
      el.pageHint.textContent = host + ' · 已翻译 ' + status.done + ' 段' + (status.queued ? '（进行中）' : '');
      el.translateBtn.textContent = '重新翻译';
    } else {
      el.translateBtn.textContent = '翻译当前页面';
    }
    el.translateBtn.disabled = false;
    el.restoreBtn.disabled = false;
    el.selBtn.disabled = false;
  }

  function sendTabAction(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: '没有响应' });
      });
    });
  }

  /* --------------------------------- 事件 --------------------------------- */

  el.targetLang.addEventListener('change', function () {
    syncEngineVisibility();
    const name = T.languageName(el.targetLang.value);
    scheduleSave({ immediate: true, notice: '目标语言已切换为' + name + '，正在重新翻译当前页面…' });
  });

  el.engine.addEventListener('change', function () {
    syncEngineVisibility();
    const isDeepSeek = el.engine.value !== T.ENGINE_GOOGLE;
    if (isDeepSeek && !el.apiKey.value.trim()) {
      setStatus('提示：未填写 DeepSeek API Key 时会自动使用免费 Google 接口。', 'busy');
    } else if (!isDeepSeek) {
      setStatus('已切换到 Google 免费接口，无需 API Key。', 'ok');
    }
    scheduleSave({ immediate: true });
  });

  [el.apiKey, el.apiBase, el.model].forEach(function (input) {
    input.addEventListener('input', function () { scheduleSave(); });
    input.addEventListener('change', function () { scheduleSave({ immediate: true, notice: '已保存设置。' }); });
  });

  el.autoTranslate.addEventListener('change', function () {
    scheduleSave({ immediate: true, notice: el.autoTranslate.checked ? '已开启自动翻译（新打开的页面生效）。' : '已关闭自动翻译。' });
  });

  el.overlayEnabled.addEventListener('change', function () {
    if (currentTab && currentTab.id != null) {
      sendTabAction({
        type: 'DSH_TAB_ACTION',
        tabId: currentTab.id,
        action: 'overlay',
        enabled: el.overlayEnabled.checked,
      });
    }
    scheduleSave({ immediate: true });
  });

  el.debug.addEventListener('change', function () { scheduleSave({ immediate: true }); });

  el.translateBtn.addEventListener('click', async function () {
    if (!currentTab) return;
    setStatus('正在翻译当前页面…', 'busy');
    el.translateBtn.disabled = true;
    const result = await sendTabAction({
      type: 'DSH_TAB_ACTION',
      tabId: currentTab.id,
      action: 'translate',
      target: T.normalizeLang(el.targetLang.value),
    });
    el.translateBtn.disabled = false;
    if (result && result.ok) {
      setStatus('已翻译 ' + (result.done || 0) + ' 段文本' + (result.failed ? '，失败 ' + result.failed + ' 段' : '') + '。', 'ok');
      setTimeout(refreshPageStatus, 400);
    } else {
      setStatus('翻译失败：' + ((result && result.error) || '未知错误'), 'error');
    }
  });

  el.restoreBtn.addEventListener('click', async function () {
    if (!currentTab) return;
    const result = await sendTabAction({ type: 'DSH_TAB_ACTION', tabId: currentTab.id, action: 'restore' });
    if (result && result.ok) {
      setStatus('已还原为原文。', 'ok');
      setTimeout(refreshPageStatus, 300);
    } else {
      setStatus('还原失败：' + ((result && result.error) || '未知错误'), 'error');
    }
  });

  el.selBtn.addEventListener('click', async function () {
    if (!currentTab) return;
    const result = await sendTabAction({
      type: 'DSH_TAB_ACTION',
      tabId: currentTab.id,
      action: 'translate-selection',
      text: '',
    });
    if (result && result.ok) {
      setStatus('译文：' + String(result.text || '').slice(0, 120), 'ok');
      window.close();
    } else {
      setStatus('请先在页面上选中要翻译的文字。' + ((result && result.error) ? '（' + result.error + '）' : ''), 'error');
    }
  });

  el.testBtn.addEventListener('click', async function () {
    setStatus('正在测试翻译接口…', 'busy');
    el.testBtn.disabled = true;
    const started = Date.now();
    try {
      const fresh = Object.assign({}, settings, collectSettings());
      const out = await T.translateText('Hello, world! This is a real-time translation test.', el.targetLang.value, {
        settings: fresh,
      });
      const used = fresh.engine === T.ENGINE_GOOGLE ? 'Google 免费接口' : 'DeepSeek';
      setStatus('接口正常（' + used + '，' + ((Date.now() - started) / 1000).toFixed(1) + 's）：' + out, 'ok');
    } catch (err) {
      setStatus('接口测试失败：' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      el.testBtn.disabled = false;
    }
  });

  /* --------------------------------- 启动 --------------------------------- */

  (async function init() {
    fillLanguages();
    settings = await T.getSettings();
    renderSettings();
    await refreshPageStatus();
    if (settings.engine !== T.ENGINE_GOOGLE && !settings.apiKey) {
      setStatus('尚未配置 DeepSeek API Key：当前会自动使用免费 Google 接口。', 'busy');
    } else {
      setStatus('就绪。整页翻译会替换页面原文，点“还原原文”可随时恢复。', '');
    }
  })();
})();
