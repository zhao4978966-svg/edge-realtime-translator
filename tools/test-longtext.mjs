/* =========================================================================
 * tools/test-longtext.mjs
 * 长文本路径回归：验证「超长段落 → 按句切块 → 翻译 → 拼回」不会丢内容。
 *
 * 退出码：0 通过 / 1 失败 / 2 因免费接口限流跳过
 * ========================================================================= */

import { loadTranslator } from './lib/paths.mjs';

const T = loadTranslator();

const BASE = [
  'Real-time translation is useful when you read foreign articles.',
  'It replaces the text in the page so the layout stays exactly the same.',
  'The extension watches for new content and translates it as you scroll.',
  'You can switch the target language at any time and the page is translated again.',
  'If the API key is missing, it falls back to the free Google endpoint automatically.',
  'Selecting a word or a sentence shows a small button that opens a translation card.',
  'Everything runs locally in your browser; only the text is sent to the service you chose.',
  'Long paragraphs are split at sentence boundaries and joined back together afterwards.',
  'Press Alt+Shift+T to toggle translation for the current page.',
  'Restoring the original text takes effect immediately and clears the cache.',
];

const LONG_TEXT = [
  BASE.join(' '),
  BASE.join(' ').replace(/translation/g, 'automatic translation'),
  BASE.join(' ').replace(/extension/g, 'browser add-on'),
].join(' ');

/** 与 lib/content.js 中一致的切块逻辑 */
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

const isRateLimited = (err) => /限流|HTTP 429|HTTP 403/.test(String((err && err.message) || err));
const GOOGLE_SETTINGS = Object.assign({}, T.DEFAULTS, { engine: T.ENGINE_GOOGLE });

async function main() {
  console.log('input length:', LONG_TEXT.length);

  const chunks = splitLongText(LONG_TEXT);
  console.log('chunks:', chunks.length, chunks.map((c) => c.length));

  // 第一段：整段一次性翻译（模拟引擎一次成功的情况）
  try {
    const whole = await T.translateBatch([LONG_TEXT], 'zh-CN', { settings: GOOGLE_SETTINGS });
    console.log('single-call length:', String(whole[0] || '').length);
  } catch (err) {
    if (isRateLimited(err)) {
      console.log('长文本路径: 跳过（免费接口限流）⚠️');
      return 2;
    }
    console.log('整段翻译失败：' + (err && err.message ? err.message : String(err)));
  }

  // 第二段：逐块翻译 + 失败块单独补译（模拟内容脚本的真实路径）
  let parts = null;
  try {
    parts = await T.translateBatch(chunks, 'zh-CN', { settings: GOOGLE_SETTINGS });
  } catch (err) {
    if (isRateLimited(err)) {
      console.log('长文本路径: 跳过（免费接口限流）⚠️');
      return 2;
    }
    throw err;
  }

  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) continue;
    console.log(`  片段 ${i} 首批失败，单独重试…`);
    try {
      const one = await T.translateBatch([chunks[i]], 'zh-CN', { settings: GOOGLE_SETTINGS });
      parts[i] = one[0] || null;
    } catch (err) {
      if (isRateLimited(err)) {
        console.log('长文本路径: 跳过（免费接口限流）⚠️');
        return 2;
      }
      throw err;
    }
  }

  const joined = parts.join(' ');
  console.log('逐片译文长度:', parts.map((p) => (p ? p.length : 'null')));
  console.log('joined length:', joined.length);
  console.log('joined tail:', joined.slice(-50));

  const ok = parts.every(Boolean) && joined.length > LONG_TEXT.length * 0.25;
  console.log('长文本路径:', ok ? '通过 ✅' : '失败 ❌');
  return ok ? 0 : 1;
}

process.exit(await main());
