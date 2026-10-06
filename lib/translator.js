/* =========================================================================
 * lib/translator.js —— 翻译引擎（内容脚本前置库，也可被 popup 引用测试）
 * 1) DeepSeek / OpenAI 兼容的 Chat Completions（默认，质量最好）
 * 2) 免费 Google 翻译端点（translate.googleapis.com，无需 Key，作为兜底）
 * ========================================================================= */
(function (global) {
  'use strict';

  const ENGINE_DEEPSEEK = 'deepseek';
  const ENGINE_GOOGLE = 'google';

  const DEFAULTS = {
    autoTranslate: true,
    targetLang: 'zh-CN',
    engine: ENGINE_DEEPSEEK,
    apiBase: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    googleApiKey: '',            // 可留空：走免费端点
    googleEndpoint: 'https://translate.googleapis.com/translate_a/single',
    batchSize: 12,
    skipSameLang: true,
    allowGoogleFallback: true,
    debug: false,
  };

  /** 语言代码归一化：把各种写法收敛成 Google 能识别的代码，同时保留提示词可读性 */
  const LANG_ALIAS = {
    'zh': 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN', 'zh-sg': 'zh-CN',
    'zh-hant': 'zh-TW', 'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW',
    'en-us': 'en', 'en-gb': 'en', 'ja-jp': 'ja', 'ko-kr': 'ko',
    'de-de': 'de', 'fr-fr': 'fr', 'es-es': 'es', 'pt-br': 'pt', 'ru-ru': 'ru',
  };

  const RTL_LANGS = ['ar', 'he', 'fa', 'ur'];

  const LANGUAGE_OPTIONS = [
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English 英语' },
    { code: 'ja', name: '日本語 日语' },
    { code: 'ko', name: '한국어 韩语' },
    { code: 'fr', name: 'Français 法语' },
    { code: 'de', name: 'Deutsch 德语' },
    { code: 'es', name: 'Español 西班牙语' },
    { code: 'pt', name: 'Português 葡萄牙语' },
    { code: 'it', name: 'Italiano 意大利语' },
    { code: 'ru', name: 'Русский 俄语' },
    { code: 'ar', name: 'العربية 阿拉伯语' },
    { code: 'hi', name: 'हिन्दी 印地语' },
    { code: 'th', name: 'ไทย 泰语' },
    { code: 'vi', name: 'Tiếng Việt 越南语' },
    { code: 'id', name: 'Bahasa Indonesia 印尼语' },
    { code: 'tr', name: 'Türkçe 土耳其语' },
    { code: 'nl', name: 'Nederlands 荷兰语' },
    { code: 'pl', name: 'Polski 波兰语' },
  ];

  function normalizeLang(code, fallback) {
    if (!code) return fallback || 'zh-CN';
    const key = String(code).trim().toLowerCase();
    if (key === 'auto' || key === '') return fallback || 'zh-CN';
    return LANG_ALIAS[key] || String(code).trim();
  }

  function languageName(code) {
    const norm = normalizeLang(code);
    const found = LANGUAGE_OPTIONS.find(function (item) { return item.code === norm; });
    return found ? found.name : norm;
  }

  function getSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(DEFAULTS, function (stored) {
          const merged = Object.assign({}, DEFAULTS, stored || {});
          if (chrome.runtime.lastError) {
            resolve(Object.assign({}, DEFAULTS));
            return;
          }
          merged.targetLang = normalizeLang(merged.targetLang);
          if (merged.engine !== ENGINE_GOOGLE) merged.engine = ENGINE_DEEPSEEK;
          merged.batchSize = Math.min(Math.max(parseInt(merged.batchSize, 10) || 12, 2), 30);
          resolve(merged);
        });
      } catch (err) {
        resolve(Object.assign({}, DEFAULTS));
      }
    });
  }

  function saveSettings(patch) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(patch, function () { resolve(true); });
    });
  }

  /* ------------------------------ 缓存 / 去重 ------------------------------ */

  const cache = new Map();
  const inflight = new Map();
  const MAX_CACHE = 4000;

  function cacheKey(text, target) {
    return target + '\u0000' + text;
  }

  function cacheGet(text, target) {
    return cache.get(cacheKey(text, target));
  }

  function cacheSet(text, target, value) {
    if (cache.size >= MAX_CACHE) {
      // 简单的 FIFO 淘汰
      let drop = Math.floor(MAX_CACHE * 0.1);
      for (const key of cache.keys()) {
        cache.delete(key);
        if (--drop <= 0) break;
      }
    }
    cache.set(cacheKey(text, target), value);
  }

  function clearCache() {
    cache.clear();
    inflight.clear();
  }

  /* -------------------------------- 引擎实现 ------------------------------- */

  function buildPrompt(texts, target) {
    const list = texts.map(function (text, index) {
      return '[' + index + '] ' + text.replace(/\n+/g, ' ');
    }).join('\n');
    return '请把下面每一行以 [序号] 开头的文本翻译成' + languageName(target) + '。\n' +
      '要求：\n' +
      '1. 保持 [序号] 原样且顺序不变；\n' +
      '2. 只翻译文本本身，保留原有的数字、URL、邮箱、代码、变量名、专有名词；\n' +
      '3. 不要解释、不要添加任何额外内容；\n' +
      '4. 严格输出 JSON 对象，格式为 {"t":["译文0","译文1", ...]}，数组长度必须等于输入行数。\n\n' +
      '待翻译内容：\n' + list;
  }

  function extractJsonArray(raw, expected) {
    if (!raw) return null;
    let text = String(raw).trim();
    // 去掉可能的 ```json ``` 围栏
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const first = text.search(/[[{]/);
    const lastBracket = text.lastIndexOf(']');
    const lastBrace = text.lastIndexOf('}');
    if (first >= 0) {
      const candidate = text.slice(first, Math.max(lastBracket, lastBrace) + 1);
      try {
        const parsed = JSON.parse(candidate);
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.t) ? parsed.t : null);
        if (Array.isArray(arr) && arr.length === expected) {
          return arr.map(function (item) { return item == null ? '' : String(item); });
        }
        if (Array.isArray(arr) && arr.length > 0) return arr.map(function (item) { return item == null ? '' : String(item); });
      } catch (err) { /* 继续尝试逐行解析 */ }
    }
    // 退路：按 [序号] 行解析
    const lines = text.split(/\n+/).map(function (line) {
      return line.replace(/^\s*\[\d+\]\s*/, '').replace(/^\s*"\s*|\s*"\s*$/g, '').trim();
    }).filter(Boolean);
    return lines.length ? lines : null;
  }

  async function translateWithDeepSeek(texts, target, settings) {
    if (!settings.apiKey) {
      throw new Error('未填写 DeepSeek API Key');
    }
    const base = String(settings.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 60000);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + settings.apiKey,
        },
        body: JSON.stringify({
          model: settings.model || DEFAULTS.model,
          temperature: 0,
          stream: false,
          messages: [
            { role: 'system', content: '你是专业的网页翻译引擎，只输出用户要求的 JSON 结果。' },
            { role: 'user', content: buildPrompt(texts, target) },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(function () { return ''; });
      let detail = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.error && parsed.error.message) detail = parsed.error.message;
      } catch (err) { /* 保留原文 */ }
      throw new Error('接口返回 ' + response.status + '：' + detail);
    }

    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    const arr = extractJsonArray(content, texts.length);
    if (!arr || !arr.length) throw new Error('模型返回内容无法解析为译文数组');
    return texts.map(function (_, index) {
      return arr[index] != null && String(arr[index]).trim() ? String(arr[index]).trim() : null;
    });
  }

  async function googleQuery(texts, target, settings) {
    const params = new URLSearchParams();
    params.set('client', 'gtx');
    params.set('sl', 'auto');
    params.set('tl', normalizeLang(target));
    params.set('dt', 't');
    if (settings && settings.googleApiKey) params.set('key', settings.googleApiKey);
    texts.forEach(function (text) { params.append('q', text); });

    const endpoint = (settings && settings.googleEndpoint) || DEFAULTS.googleEndpoint;
    const url = endpoint + '?' + params.toString();

    // 免费端点会限流（HTTP 429），这里做一次退避重试
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, 30000);
      let response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 429 || response.status === 403) {
        lastStatus = response.status;
        if (attempt < 2) {
          await new Promise(function (resolve) { setTimeout(resolve, 700 * Math.pow(2, attempt)); });
          continue;
        }
        throw new Error(
          '免费 Google 翻译接口被限流（HTTP ' + lastStatus + '）。' +
          '请在扩展面板中配置 DeepSeek API Key，或稍后重试。'
        );
      }
      if (!response.ok) throw new Error('Google 翻译接口返回 ' + response.status);
      const data = await response.json();
      if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Google 翻译返回格式异常');
      // data[0] 是若干「片段」，长句会被拆成多段返回，必须全部拼接，否则会丢内容
      const pieces = data[0]
        .map(function (part) { return part && part[0] ? String(part[0]) : ''; })
        .filter(function (piece) { return piece.length > 0; });
      return [pieces.join('')];
    }
    throw new Error('免费 Google 翻译接口不可用（HTTP ' + lastStatus + '）');
  }

  /**
   * 免费 Google 端点（translate_a/single）对“一次多个 q”的返回并不可靠，
   * 因此这里始终逐条请求，用有限并发控制速度与频率。
   */
  async function translateWithGoogle(texts, target, settings) {
    const out = new Array(texts.length).fill(null);
    const CONCURRENCY = 3;
    let cursor = 0;
    let okCount = 0;
    let firstError = null;
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, texts.length); i++) {
      workers.push((async function () {
        for (;;) {
          const index = cursor++;
          if (index >= texts.length) return;
          const text = texts[index];
          if (text.length > 5000) {
            // 免费端点不适合超长文本，交给上层按句切分处理，避免只译出前半段
            firstError = firstError || new Error('单条文本超过 5000 字符');
            continue;
          }
          try {
            const one = await googleQuery([text], target, settings);
            if (one[0]) {
              out[index] = one[0];
              okCount++;
            } else {
              firstError = firstError || new Error('Google 返回空译文');
            }
          } catch (err) {
            firstError = firstError || err;
          }
          // 轻微错峰，降低被限流的概率
          await new Promise(function (resolve) { setTimeout(resolve, 60); });
        }
      })());
    }
    await Promise.all(workers);
    // 一条都没成功时把真实原因抛出去，避免上层只看到“空结果”
    if (!okCount && texts.length && firstError) throw firstError;
    return out;
  }

  /**
   * 批量翻译入口。
   * @returns {Promise<Array<string|null>>} 与输入等长；失败项为 null
   */
  async function translateBatch(texts, targetLang, options) {
    // 注意合并顺序：调用方显式传入的 settings 必须覆盖默认值
    const settings = Object.assign({}, DEFAULTS, options && options.settings ? options.settings : {});
    const target = normalizeLang(targetLang, settings.targetLang);
    const results = new Array(texts.length).fill(null);
    const pending = [];
    const pendingIndex = [];

    texts.forEach(function (text, index) {
      const hit = cacheGet(text, target);
      if (hit != null) {
        results[index] = hit;
        return;
      }
      const key = cacheKey(text, target);
      if (inflight.has(key)) {
        inflight.get(key).then(function (value) { results[index] = value; }).catch(function () {});
        return;
      }
      pending.push(text);
      pendingIndex.push(index);
    });

    if (!pending.length) return results;

    let engine = settings.engine === ENGINE_GOOGLE ? ENGINE_GOOGLE : ENGINE_DEEPSEEK;
    const fallbackAllowed = settings.allowGoogleFallback !== false;
    // 没填 Key 时直接走 Google，省掉一次必然失败的 DeepSeek 请求
    if (engine === ENGINE_DEEPSEEK && !settings.apiKey && fallbackAllowed) {
      engine = ENGINE_GOOGLE;
    }

    let translated = null;
    let firstError = null;
    try {
      translated = engine === ENGINE_GOOGLE
        ? await translateWithGoogle(pending, target, settings)
        : await translateWithDeepSeek(pending, target, settings);
    } catch (err) {
      firstError = err;
    }

    // 主引擎失败时自动回落到免费 Google
    if ((!translated || !translated.length) && engine === ENGINE_DEEPSEEK && fallbackAllowed) {
      try {
        translated = await translateWithGoogle(pending, target, settings);
        if (firstError) console.warn('[网页翻译] DeepSeek 失败，已回落 Google：', firstError.message);
      } catch (err2) {
        const googleMessage = err2 && err2.message ? err2.message : String(err2);
        if (firstError) {
          firstError = new Error('主引擎：' + firstError.message + '；Google 兜底：' + googleMessage);
        } else {
          firstError = err2;
        }
      }
    }

    if (!translated || !translated.length) {
      throw firstError || new Error('翻译失败');
    }

    pending.forEach(function (text, i) {
      const value = translated[i] != null && String(translated[i]).length ? String(translated[i]) : null;
      if (value != null) {
        cacheSet(text, target, value);
        inflight.delete(cacheKey(text, target));
      }
      results[pendingIndex[i]] = value;
    });

    return results;
  }

  /** 单条文本翻译（划词 / 测试用），带自动重试一次 */
  async function translateText(text, targetLang, options) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await translateBatch([clean], targetLang, options);
        if (out[0]) return out[0];
        lastError = lastError || new Error('翻译结果为空');
      } catch (err) {
        lastError = err;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 600); });
    }
    throw lastError || new Error('翻译失败');
  }

  function isRtlTarget(target) {
    return RTL_LANGS.indexOf(normalizeLang(target).split('-')[0]) >= 0;
  }

  global.DSHTranslate = {
    DEFAULTS: DEFAULTS,
    ENGINE_DEEPSEEK: ENGINE_DEEPSEEK,
    ENGINE_GOOGLE: ENGINE_GOOGLE,
    LANGUAGE_OPTIONS: LANGUAGE_OPTIONS,
    normalizeLang: normalizeLang,
    languageName: languageName,
    getSettings: getSettings,
    saveSettings: saveSettings,
    translateBatch: translateBatch,
    translateText: translateText,
    clearCache: clearCache,
    isRtlTarget: isRtlTarget,
  };
})(typeof window !== 'undefined' ? window : globalThis);
