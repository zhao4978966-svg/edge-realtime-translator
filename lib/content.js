/* =========================================================================
 * lib/content.js —— 页面内实时翻译
 * 功能：
 *   - 整页自动翻译（只处理可见文本节点，跳过代码/表单/已翻译内容）
 *   - 动态内容监听（MutationObserver，适配无限滚动与单页应用）
 *   - 划词即时翻译（选中文本 → 悬浮按钮 → 译文卡片）
 * ========================================================================= */
(function () {
  'use strict';

  if (window.__DSH_TRANSLATOR_LOADED__) return;
  window.__DSH_TRANSLATOR_LOADED__ = true;

  const T = window.DSHTranslate;
  if (!T) return;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'IFRAME', 'CANVAS',
    'TEMPLATE', 'AUDIO', 'VIDEO', 'OBJECT', 'EMBED',
  ]);
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'SUMMARY',
  ]);
  const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
  const HAS_MEANING_RE = /[0-9A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

  /* --------------------------------- 状态 --------------------------------- */

  const state = {
    settings: null,
    active: false,
    running: false,
    target: 'zh-CN',
    queue: [],
    queued: new Set(),
    originals: new WeakMap(),
    // 记录我们最近写入节点的译文，用来识别“自己触发的 mutation”，避免把原文覆盖掉
    lastApplied: new WeakMap(),
    originalNodes: new Set(),
    pendingList: [],
    pendingSet: new Set(),
    done: 0,
    failed: 0,
    pages: 0,
    token: 0,
    overlayEnabled: true,
    prefetched: false,
  };

  const ui = { root: null, progress: null, badge: null, popup: null, btn: null, lastSelection: null, moved: false };
  // 每轮扫描重建一次，避免依赖 WeakMap.prototype.clear（部分环境不可用）
  let visCache = new WeakMap();
  let bodyObserver = null;
  let flushTimer = null;

  function log() {
    if (state.settings && state.settings.debug) {
      console.log.apply(console, ['[网页翻译]'].concat(Array.prototype.slice.call(arguments)));
    }
  }

  /* ------------------------------ 设置 / 初始化 ----------------------------- */

  async function loadSettings() {
    state.settings = await T.getSettings();
    state.target = T.normalizeLang(state.settings.targetLang);
    return state.settings;
  }

  function isTranslatablePage() {
    if (!document.body) return false;
    const url = location.href;
    if (/^(edge|about|chrome|devtools|view-source|extension|data|blob):/i.test(url)) return false;
    return true;
  }

  function pageIsNoTranslate() {
    const html = document.documentElement;
    if (html && html.getAttribute('translate') === 'no') return true;
    const meta = document.querySelector('meta[name="google"][content="notranslate"], meta[name="robots"][content*="notranslate"]');
    return !!meta;
  }

  /** 粗略判断页面主体语言是否已经是目标语言，避免无意义翻译 */
  function pageLooksLikeTarget() {
    if (!state.settings || !state.settings.skipSameLang) return false;
    const target = state.target;
    if (target.split('-')[0] !== 'zh') return false;

    const declared = (document.documentElement && document.documentElement.lang || '').toLowerCase();
    if (declared.indexOf('zh') === 0 || declared.indexOf('ja') === 0) return true;

    const sample = (document.body ? document.body.innerText : '').replace(/\s+/g, '').slice(0, 800);
    if (sample.length < 40) return false;
    const cjk = (sample.match(new RegExp(CJK_RE.source, 'g')) || []).length;
    return cjk / sample.length > 0.25;
  }

  /* -------------------------------- 文本节点扫描 ---------------------------- */

  /** 显式隐藏：inline 样式、hidden 属性、aria-hidden、translate=no */
  function hardHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const style = el.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    const translate = el.getAttribute('translate');
    if (translate === 'no') return true;
    return false;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!el.isConnected) return false;

    // 沿祖先链检查计算样式（display:none / visibility:hidden 会沿树继承生效）
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      if (hardHidden(node)) return false;
      const tag = node.tagName;
      if (tag === 'DIALOG' && !node.open) return false;
      if (tag === 'DETAILS') {
        const parent = node.parentElement;
        if (parent && parent.tagName === 'DETAILS' && !parent.open) return false;
      }
      if (node !== el && visCache.has(node)) {
        if (visCache.get(node) === false) return false;
        break;
      }
      node = node.parentElement;
      depth++;
    }

    // 不要用 offsetParent：某些渲染环境（如无头模式）对正常元素也返回 null
    let result = true;
    try {
      const computed = window.getComputedStyle(el);
      if (computed.display === 'none' || computed.visibility === 'hidden' || computed.visibility === 'collapse') {
        result = false;
      }
    } catch (err) {
      result = true;
    }
    visCache.set(el, result);
    return result;
  }

  function isSkippedContext(el) {
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      if (node.isContentEditable) return true;
      const role = node.getAttribute && node.getAttribute('role');
      if (role === 'textbox' || role === 'code') return true;
      if (node.classList && (node.classList.contains('notranslate') || node.classList.contains('dsh-translator-root'))) return true;
      if (node.id === 'dsh-translator-root') return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  function hasTranslatableChars(text) {
    const value = text.trim();
    if (value.length < 2) return false;
    return HAS_MEANING_RE.test(value);
  }

  function containsTextNode(el) {
    if (!el || el.nodeType !== 1) return false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return hasTranslatableChars(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    return !!walker.nextNode();
  }

  function ensureQueue(node) {
    if (state.queued.has(node)) return;
    const text = node.nodeValue;
    if (!text || !hasTranslatableChars(text)) return;
    if (state.pendingSet.has(node)) return;
    const parent = node.parentElement;
    if (!parent) return;
    if (isSkippedContext(parent)) return;
    if (!isVisible(parent)) return;
    state.originals.set(node, text);
    state.originalNodes.add(node);
    if (state.originalNodes.size > 8000) pruneOriginalNodes();
    state.queued.add(node);
    state.queue.push({
      node: node,
      text: text.replace(/\s+/g, ' ').trim(),
      target: state.target,
      token: state.token,
    });
  }

  function collectFrom(root) {
    if (!root) return;
    visCache = new WeakMap();
    if (root.nodeType === Node.TEXT_NODE) {
      ensureQueue(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (isSkippedContext(root)) return;
      if (!isVisible(root)) return;
      if (root.tagName === 'TEXTAREA' || root.tagName === 'INPUT') return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        const text = node.nodeValue;
        if (!text || !hasTranslatableChars(text)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const blockHits = new Map();
    let node;
    let scanned = 0;
    while ((node = walker.nextNode())) {
      // 快路径：整块文本很短时直接判断
      const parent = node.parentElement;
      if (!parent) continue;
      if (isSkippedContext(parent)) continue;

      if (BLOCK_TAGS.has(parent.tagName) && !blockHits.has(parent)) {
        blockHits.set(parent, containsTextNode(parent));
      }
      if (BLOCK_TAGS.has(parent.tagName) && blockHits.get(parent) === false) continue;

      if (!isVisible(parent)) continue;

      // 超长文本节点（如整段正文）：整体作为一个条目入队，由引擎层按长度自适应处理，
      // 避免在页面里插入额外节点、破坏站点自身的 DOM 结构。
      ensureQueue(node);
      scanned++;
      if (scanned > 5000) break;
    }
  }

  function clearTranslatable() {
    state.queue.length = 0;
    state.queued.clear();
    state.pendingList.length = 0;
    state.pendingSet.clear();
  }

  /** 清理已经脱离文档的旧节点记录，防止长会话下集合无限膨胀 */
  function pruneOriginalNodes() {
    for (const node of state.originalNodes) {
      if (!node.isConnected) state.originalNodes.delete(node);
      if (state.originalNodes.size <= 5000) break;
    }
  }

  function restoreNode(node) {
    const original = state.originals.get(node);
    if (original == null) return;
    try {
      if (node.isConnected && node.nodeValue !== original) node.nodeValue = original;
    } catch (err) { /* 节点可能已失效 */ }
  }

  function restoreAll() {
    state.token++;
    clearTranslatable();
    state.originalNodes.forEach(function (node) { restoreNode(node); });
    state.active = false;
    state.running = false;
    state.done = 0;
    state.failed = 0;
    setBadge('off');
    T.clearCache();
  }

  /* -------------------------------- 队列 / 工作器 ---------------------------- */

  async function runPool(concurrency) {
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push((async function () {
        for (;;) {
          if (!state.active) return;
          const taken = takeBatch();
          if (!taken.length) return;
          await processBatch(taken);
        }
      })());
    }
    await Promise.all(workers);
  }

  /** 按条数与字符数双阈值截取一批待翻译条目 */
  function takeBatch() {
    const size = state.settings && state.settings.batchSize ? state.settings.batchSize : 12;
    const taken = [];
    let chars = 0;
    while (state.queue.length && taken.length < size) {
      const item = state.queue[0];
      if (taken.length > 0 && chars + item.text.length > 2200) break;
      taken.push(state.queue.shift());
      chars += item.text.length;
    }
    return taken;
  }

  /** 过长的文本（如整段正文）按句子边界切块，翻译后再拼回一个节点 */
  const MAX_DIRECT_CHARS = 1200;

  function splitLongText(text) {
    const chunks = [];
    let current = '';
    const sentences = text.match(/[^.!?。！？；;\n]+[.!?。！？；;]?|\n/g) || [text];
    for (const sentence of sentences) {
      if (current.length + sentence.length > MAX_DIRECT_CHARS && current) {
        chunks.push(current);
        current = '';
      }
      current += sentence;
    }
    if (current.trim()) chunks.push(current);
    return chunks.length ? chunks : [text];
  }

  async function processBatch(items) {
    if (!items.length) return;
    const texts = items.map(function (item) { return item.text; });
    const token = state.token;
    const target = items[0].target;
    let results = null;
    try {
      results = await T.translateBatch(texts, target, { settings: state.settings });
    } catch (err) {
      if (items.length > 1) {
        // 整批失败：拆成单条重排，避免一条坏数据拖垮整批
        requeueSingles(items);
        updateProgress();
        return;
      }
      console.warn('[网页翻译] 翻译失败：', err && err.message);
      noteError(err && err.message ? err.message : String(err));
      state.failed += 1;
      state.queued.delete(items[0].node);
      state.pendingSet.delete(items[0].node);
      updateProgress();
      return;
    }
    if (!state.active || token !== state.token) return;

    let ok = 0;
    const bad = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      state.pendingSet.delete(item.node);
      const original = state.originals.get(item.node);
      let value = results[index];
      // 超长条目：引擎无法一次译完时按句切块补译
      if (value == null && item.text.length > MAX_DIRECT_CHARS) {
        value = await translateLongText(item.text, target, token);
      }
      if (value && original != null && item.node.isConnected) {
        try {
          item.node.nodeValue = value;
          state.lastApplied.set(item.node, value);
          ok++;
          continue;
        } catch (err) { /* 计入失败 */ }
      }
      bad.push(item);
    }

    if (bad.length && bad.length < items.length) {
      // 部分条目没译出来：单独重排队（单条请求不会串位）
      requeueSingles(bad);
    } else if (bad.length) {
      bad.forEach(function (item) {
        state.queued.delete(item.node);
        state.pendingSet.delete(item.node);
      });
      state.failed += bad.length;
    }

    state.done += ok;
    updateProgress();
    maybePrefetch();
  }

  async function translateLongText(text, target, token) {
    const chunks = splitLongText(text);
    if (chunks.length <= 1) return null;
    let parts = null;
    try {
      parts = await T.translateBatch(chunks, target, { settings: state.settings });
    } catch (err) {
      return null;
    }
    if (!state.active || token !== state.token) return null;

    // 部分片段失败时逐条单独补译（单条请求更稳，不容易被限流）
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) continue;
      if (!state.active || token !== state.token) return null;
      try {
        parts[i] = await T.translateBatch([chunks[i]], target, { settings: state.settings }).then(function (one) {
          return one[0] || null;
        });
      } catch (err) {
        parts[i] = null;
      }
    }
    if (parts.some(function (part) { return !part; })) return null;
    return parts.join(' ');
  }

  /** 把一批条目拆成单条重新排队（最多重试一次） */
  function requeueSingles(items) {
    items.forEach(function (item) {
      state.queued.delete(item.node);
      state.pendingSet.delete(item.node);
      item.retry = (item.retry || 0) + 1;
      if (item.retry <= 1) {
        state.queue.push(item);
        state.pendingSet.add(item.node);
      } else {
        state.failed++;
      }
    });
  }

  function scheduleFlush(delay) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      flushTimer = null;
      void runPool(3);
    }, delay == null ? 80 : delay);
  }

  async function translatePage() {
    if (state.running) return;
    state.running = true;
    try {
      collectFrom(document.body);
      updateProgress(true);
      await runPool(3);
      updateProgress(true);
    } finally {
      state.running = false;
    }
  }

  /** 剩余内容还有不少时，继续把可见区域补齐（滚动触发） */
  function maybePrefetch() {
    if (!state.active) return;
    if (!state.queue.length) return;
    scheduleFlush(200);
  }

  /* --------------------------------- 进度 UI -------------------------------- */

  function ensureUI() {
    if (ui.root && ui.root.isConnected) return ui.root;
    const root = document.createElement('div');
    root.id = 'dsh-translator-root';
    root.className = 'dsh-translator-root';
    root.setAttribute('translate', 'no');
    root.setAttribute('data-dsh-ui', '1');

    const progress = document.createElement('div');
    progress.className = 'dsh-progress';
    progress.innerHTML = '<span class="dsh-dot"></span><span class="dsh-progress-text">正在翻译…</span>';
    root.appendChild(progress);

    const btn = document.createElement('div');
    btn.className = 'dsh-sel-btn';
    btn.innerHTML = '<span class="dsh-sel-icon">译</span>';
    btn.title = '翻译选中的文字';
    btn.addEventListener('mousedown', function (event) {
      event.preventDefault();
      event.stopPropagation();
    });
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      const text = ui.lastSelection;
      hideSelectionButton();
      if (text) void showTranslationCard(text);
    });
    root.appendChild(btn);

    (document.documentElement || document.body).appendChild(root);
    ui.root = root;
    ui.progress = progress;
    ui.btn = btn;
    return root;
  }

  function setProgressText(text, kind) {
    if (!ui.progress) return;
    ui.progress.setAttribute('data-kind', kind || '');
    const label = ui.progress.querySelector('.dsh-progress-text');
    if (label) label.textContent = text;
  }

  /** 把最近一次错误记录到 DOM 上，便于排查（也方便自动化测试读取） */
  function noteError(message) {
    try {
      if (!ui.root) return;
      ui.root.setAttribute('data-dsh-last-error', String(message).slice(0, 400));
      ui.root.setAttribute('data-dsh-failed', String(state.failed));
      ui.root.setAttribute('data-dsh-done', String(state.done));
    } catch (err) { /* 忽略 */ }
  }

  function updateProgress(force) {
    if (!state.active) return;
    const total = state.done + state.failed + state.queue.length + state.pendingSet.size;
    if (!total && !force) return;
    const finished = state.done + state.failed;
    const busy = state.queue.length + state.pendingSet.size > 0;
    if (state.failed && (!busy || state.failed >= 3)) {
      setProgressText('已翻译 ' + state.done + ' 段，失败 ' + state.failed + ' 段', 'warn');
    } else if (busy) {
      setProgressText('翻译中 ' + finished + '/' + total, 'busy');
    } else {
      setProgressText('已翻译 ' + state.done + ' 段（' + T.languageName(state.target) + '）', 'done');
    }
    flashProgress(busy ? 2600 : 2200);
  }

  let progressHideTimer = null;
  function flashProgress(ms) {
    if (!ui.progress) return;
    ui.progress.classList.add('dsh-show');
    if (progressHideTimer) clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(function () {
      if (ui.progress) ui.progress.classList.remove('dsh-show');
    }, ms);
  }

  function setBadge(kind) {
    if (!ui.badge) return;
    ui.badge.setAttribute('data-kind', kind);
    const label = ui.badge.querySelector('.dsh-badge-text');
    if (label) label.textContent = kind === 'on' ? '译' : '原';
  }

  /* ------------------------------- 划词翻译相关 ------------------------------ */

  function selectionIsValid(selection) {
    if (!selection || selection.isCollapsed) return false;
    const text = String(selection.toString() || '').trim();
    if (text.length < 1 || text.length > 5000) return false;
    if (!HAS_MEANING_RE.test(text)) return false;
    const anchor = selection.anchorNode;
    if (anchor && anchor.parentElement && isSkippedContext(anchor.parentElement)) return false;
    return true;
  }

  function showSelectionButton(rect) {
    ensureUI();
    const btn = ui.btn;
    const width = 30;
    const top = window.scrollY + rect.top - width - 8;
    const left = window.scrollX + rect.left + rect.width / 2 - width / 2;
    btn.style.top = Math.max(window.scrollY + 4, top) + 'px';
    btn.style.left = Math.max(4, Math.min(left, window.scrollX + document.documentElement.clientWidth - width - 4)) + 'px';
    btn.classList.add('dsh-show');
  }

  function hideSelectionButton() {
    if (ui.btn) ui.btn.classList.remove('dsh-show');
  }

  async function showTranslationCard(text) {
    ensureUI();
    const root = ui.root;
    if (ui.popup && ui.popup.parentNode) ui.popup.parentNode.removeChild(ui.popup);

    const popup = document.createElement('div');
    popup.className = 'dsh-popup';
    popup.innerHTML =
      '<div class="dsh-popup-head">' +
        '<span class="dsh-popup-title">划词翻译</span>' +
        '<button class="dsh-popup-close" title="关闭">×</button>' +
      '</div>' +
      '<div class="dsh-popup-body">' +
        '<div class="dsh-popup-loading">翻译中…</div>' +
      '</div>' +
      '<div class="dsh-popup-foot">' +
        '<button class="dsh-btn dsh-popup-copy">复制译文</button>' +
        '<span class="dsh-popup-engine"></span>' +
      '</div>';

    const selection = window.getSelection();
    let rect = null;
    try {
      rect = selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    } catch (err) { rect = null; }
    const top = window.scrollY + (rect ? rect.bottom + 10 : 80);
    const left = window.scrollX + (rect ? rect.left : 40);
    popup.style.top = Math.max(window.scrollY + 8, top) + 'px';
    popup.style.left = Math.max(8, Math.min(left, window.scrollX + document.documentElement.clientWidth - 380)) + 'px';
    if (T.isRtlTarget(state.target)) popup.setAttribute('dir', 'rtl');

    popup.querySelector('.dsh-popup-close').addEventListener('click', function () {
      if (popup.parentNode) popup.parentNode.removeChild(popup);
    });
    popup.querySelector('.dsh-popup-copy').addEventListener('click', async function (event) {
      const body = popup.querySelector('.dsh-popup-body');
      try {
        await navigator.clipboard.writeText(body.innerText.trim());
        event.target.textContent = '已复制';
        setTimeout(function () { event.target.textContent = '复制译文'; }, 1400);
      } catch (err) {
        event.target.textContent = '复制失败';
      }
    });

    root.appendChild(popup);
    ui.popup = popup;

    const body = popup.querySelector('.dsh-popup-body');
    const engineLabel = popup.querySelector('.dsh-popup-engine');
    const started = Date.now();
    try {
      const settings = state.settings || await loadSettings();
      const engine = settings.engine === T.ENGINE_GOOGLE ? 'Google' : 'DeepSeek';
      const value = await T.translateText(text, state.target, { settings: settings });
      body.innerHTML = '';
      const src = document.createElement('div');
      src.className = 'dsh-popup-src';
      src.textContent = text.length > 400 ? text.slice(0, 400) + '…' : text;
      const dst = document.createElement('div');
      dst.className = 'dsh-popup-dst';
      dst.textContent = value;
      body.appendChild(src);
      body.appendChild(dst);
      engineLabel.textContent = engine + ' · ' + T.languageName(state.target) + ' · ' + ((Date.now() - started) / 1000).toFixed(1) + 's';
    } catch (err) {
      body.innerHTML = '';
      const error = document.createElement('div');
      error.className = 'dsh-popup-error';
      error.textContent = '翻译失败：' + (err && err.message ? err.message : String(err));
      body.appendChild(error);
      engineLabel.textContent = '';
    }
  }

  /* ------------------------------ 事件：划词 / 滚动 --------------------------- */

  function handleSelectionChange(event) {
    if (!state.overlayEnabled) return;
    if (event && event.target && event.target.closest && event.target.closest('#dsh-translator-root')) return;
    const selection = window.getSelection();
    if (!selectionIsValid(selection)) {
      if (!ui.moved) hideSelectionButton();
      return;
    }
    let rect = null;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch (err) { return; }
    if (!rect || (!rect.width && !rect.height)) return;
    const text = String(selection.toString()).trim();
    ui.lastSelection = text;
    showSelectionButton(rect);
  }

  let scrollTimer = null;
  function onScroll() {
    hideSelectionButton();
    ui.moved = true;
    setTimeout(function () { ui.moved = false; }, 250);
    if (!state.active) return;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      if (!state.queue.length) collectFrom(document.body);
      if (state.queue.length) scheduleFlush(60);
    }, 350);
  }

  /* --------------------------- MutationObserver --------------------------- */

  function isOurNode(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;
    if (el.id === 'dsh-translator-root') return true;
    if (el.closest && el.closest('#dsh-translator-root')) return true;
    return false;
  }

  function startObserver() {
    if (bodyObserver || !document.body) return;
    bodyObserver = new MutationObserver(function (mutations) {
      if (!state.active) return;
      let dirty = false;
      for (const mutation of mutations) {
        if (isOurNode(mutation.target)) continue;
        if (mutation.type === 'characterData') {
          const node = mutation.target;
          if (state.pendingSet.has(node)) continue;
          const text = node.nodeValue || '';
          if (!hasTranslatableChars(text)) continue;
          // 我们自己写入的译文：忽略，绝不能把它当成新的“原文”
          if (state.lastApplied.has(node)) continue;
          if (!state.originals.has(node)) {
            // 全新文本（例如页面自己刷新了内容）
            state.queued.delete(node);
            ensureQueue(node);
          } else if (text !== state.originals.get(node)) {
            // 站点改写了这个节点：以站点的新文本作为新的原文
            state.queued.delete(node);
            state.originals.set(node, text);
            ensureQueue(node);
          }
          dirty = true;
          continue;
        }
        for (const added of mutation.addedNodes) {
          if (isOurNode(added)) continue;
          if (added.nodeType === 1 || added.nodeType === 3 || added.nodeType === 11) {
            collectFrom(added);
            dirty = true;
          }
        }
      }
      if (dirty && state.queue.length) scheduleFlush(400);
    });
    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    log('已开始监听页面内容变化');
  }

  /* ------------------------------ 启动 / 停止 ------------------------------ */

  async function startTranslating(options) {
    const settings = state.settings || await loadSettings();
    if (options && options.target) {
      state.target = T.normalizeLang(options.target);
    } else {
      state.target = T.normalizeLang(settings.targetLang);
    }

    if (!state.active) {
      state.done = 0;
      state.failed = 0;
      state.token++;
      clearTranslatable();
    }
    state.active = true;

    startObserver();
    setBadge('on');
    await translatePage();
    updateProgress(true);
    return { ok: true, done: state.done, failed: state.failed };
  }

  function stopTranslating() {
    restoreAll();
    return { ok: true };
  }

  async function setEnabled(enabled, options) {
    if (enabled) return startTranslating(options);
    stopTranslating();
    return { ok: true };
  }

  /* -------------------------------- 消息接口 ------------------------------- */

  function handleMessage(message, sender, sendResponse) {
    const type = message && message.type;
    if (!type) return false;

    switch (type) {
      case 'DSH_PING':
        sendResponse({ ok: true, loaded: true, active: state.active, done: state.done, failed: state.failed, target: state.target });
        return false;
      case 'DSH_SET_ENABLED':
        setEnabled(!!message.enabled, { target: message.target })
          .then(function (result) { sendResponse(result); })
          .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
        return true;
      case 'DSH_TRANSLATE_PAGE':
        (async function () {
          if (!state.active) return startTranslating({ target: message.target });
          collectFrom(document.body);
          await runPool(3);
          return { ok: true, done: state.done, failed: state.failed };
        })()
          .then(function (result) { sendResponse(result); })
          .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
        return true;
      case 'DSH_RESTORE':
        sendResponse(stopTranslating());
        return false;
      case 'DSH_STATUS':
        sendResponse({
          ok: true,
          active: state.active,
          done: state.done,
          failed: state.failed,
          queued: state.queue.length + state.pendingSet.size,
          target: state.target,
        });
        return false;
      case 'DSH_TRANSLATE_SELECTION': {
        const text = (message.text || '').trim() || String(window.getSelection() || '').trim();
        if (!text) {
          sendResponse({ ok: false, error: '没有选中文字' });
          return false;
        }
        (async function () {
          const settings = state.settings || await loadSettings();
          const value = await T.translateText(text, state.target, { settings: settings });
          if (message.showCard) void showTranslationCard(text);
          return { ok: true, text: value, target: state.target };
        })()
          .then(function (result) { sendResponse(result); })
          .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
        return true;
      }
      case 'DSH_SETTINGS_CHANGED':
        (async function () {
          const previousTarget = state.target;
          await loadSettings();
          state.target = T.normalizeLang(state.settings.targetLang);
          T.clearCache();
          if (state.active) {
            restoreAll();
            await startTranslating({ target: state.target });
            return { ok: true, retranslated: previousTarget !== state.target };
          }
          if (previousTarget !== state.target) return { ok: true, retranslated: false };
          return { ok: true };
        })()
          .then(function (result) { sendResponse(result); })
          .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
        return true;
      case 'DSH_TOGGLE_OVERLAY':
        state.overlayEnabled = !!message.enabled;
        if (!state.overlayEnabled) {
          hideSelectionButton();
          if (ui.popup && ui.popup.parentNode) ui.popup.parentNode.removeChild(ui.popup);
        }
        sendResponse({ ok: true, overlayEnabled: state.overlayEnabled });
        return false;
      default:
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  /* --------------------- 供自动化测试使用的钩子（隔离世界内） -------------------- */

  window.__DSH_TEST__ = {
    state: function () { return snapshotState(); },
    probe: function () { return probeDom(); },
    translate: function (target) { return startTranslating({ target: target }); },
    restore: function () { return stopTranslating(); },
  };

  function snapshotState() {
    return {
      active: state.active,
      done: state.done,
      failed: state.failed,
      queued: state.queue.length + state.pendingSet.size,
      total: state.done + state.failed + state.queue.length + state.pendingSet.size,
      target: state.target,
    };
  }

  /** 统计页面上各文本节点为什么没被翻译，用于排查“某些内容没翻译”的问题 */
  function probeDom() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const samples = [];
    let node;
    let total = 0;
    let meaningful = 0;
    while ((node = walker.nextNode()) && samples.length < 8) {
      total++;
      const text = node.nodeValue || '';
      if (!hasTranslatableChars(text)) continue;
      meaningful++;
      const parent = node.parentElement;
      if (!parent) continue;
      const skipped = isSkippedContext(parent);
      const visible = isVisible(parent);
      samples.push({
        tag: parent.tagName,
        text: text.trim().slice(0, 30),
        skipped: skipped,
        visible: visible,
        reason: skipped ? 'skipped' : (visible ? 'ok' : 'invisible'),
      });
    }
    return {
      translatablePage: isTranslatablePage(),
      sameLang: pageLooksLikeTarget(),
      total: total,
      meaningful: meaningful,
      samples: samples,
      queueLen: state.queue.length,
      done: state.done,
      failed: state.failed,
      diag: ui.root ? {
        bootError: ui.root.getAttribute('data-dsh-boot-error'),
        autoError: ui.root.getAttribute('data-dsh-auto-error'),
        lastError: ui.root.getAttribute('data-dsh-last-error'),
      } : null,
    };
  }

  /* --------------------------------- 引导 --------------------------------- */

  async function boot() {
    try {
      await bootInner();
    } catch (err) {
      const message = err && err.stack ? err.stack : String(err);
      console.error('[网页翻译] 初始化失败：', err);
      setDiag('boot-error', message.slice(0, 300));
    }
  }

  /** 把内部状态写到 DOM 上，便于排查问题（不改动页面可见内容） */
  function setDiag(key, value) {
    try {
      if (!ui.root) return;
      ui.root.setAttribute('data-dsh-' + key, String(value).slice(0, 400));
    } catch (err) { /* 忽略 */ }
  }

  async function bootInner() {
    if (!isTranslatablePage()) return;
    if (pageIsNoTranslate()) {
      log('页面声明禁止翻译，已跳过');
      return;
    }
    const settings = await loadSettings();
    state.target = T.normalizeLang(settings.targetLang);
    state.overlayEnabled = settings.overlayEnabled !== false;
    ensureUI();
    setDiag('auto', String(settings.autoTranslate));
    setDiag('target', state.target);

    document.addEventListener('mouseup', function (event) { setTimeout(function () { handleSelectionChange(event); }, 0); }, true);
    document.addEventListener('keyup', function (event) {
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt') return;
      setTimeout(function () { handleSelectionChange(event); }, 0);
    }, true);
    document.addEventListener('mousedown', function (event) {
      if (isOurNode(event.target)) return;
      hideSelectionButton();
    }, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', hideSelectionButton, { passive: true });

    if (settings.autoTranslate) {
      if (pageLooksLikeTarget()) {
        log('页面看起来已经是目标语言，跳过自动翻译');
        return;
      }
      // 等首屏渲染稳定后再开始，避免与页面自身脚本抢资源
      setTimeout(function () {
        startTranslating().catch(function (err) {
          console.warn('[网页翻译] 自动翻译失败：', err);
          setDiag('auto-error', err && err.message ? err.message : String(err));
        });
      }, 350);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { void boot(); });
  } else {
    void boot();
  }
})();