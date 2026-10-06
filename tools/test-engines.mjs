/* =========================================================================
 * tools/test-engines.mjs —— 在 Node 里实测翻译引擎（不用装扩展）
 *
 * 用法：
 *   node tools/test-engines.mjs                      # 测免费 Google 引擎
 *   node tools/test-engines.mjs --deepseek sk-xxxx   # 同时测 DeepSeek
 *   或先设置环境变量 DEEPSEEK_API_KEY
 * ========================================================================= */

import { loadTranslator } from './lib/paths.mjs';

// 让 translator.js 挂到全局，模拟浏览器环境
const T = loadTranslator();
if (!T) {
  console.error('无法加载 lib/translator.js');
  process.exit(1);
}

const args = process.argv.slice(2);
let apiKey = process.env.DEEPSEEK_API_KEY || '';
const keyIndex = args.indexOf('--deepseek');
if (keyIndex >= 0 && args[keyIndex + 1]) apiKey = args[keyIndex + 1];

const SAMPLE = [
  'The quick brown fox jumps over the lazy dog.',
  'Real-time translation keeps the page layout intact while replacing the text.',
  'Contact us at support@example.com or visit https://example.com/docs for details.',
  'Version 2.4.1 was released on 2024-06-18 and fixed 12 bugs.',
];

/** 命中限流时把用例标记为“跳过”，避免把环境限流误判成代码缺陷 */
function isRateLimited(err) {
  return /限流|HTTP 429|HTTP 403/.test(String((err && err.message) || err));
}

let allOk = true;
let rateLimited = 0;

async function run(label, settings, sample) {
  const started = Date.now();
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    const out = await T.translateBatch(sample || SAMPLE, 'zh-CN', { settings });
    out.forEach((value, index) => {
      console.log(`  [${index}] ${value == null ? '(null)' : value}`);
    });
    const okCount = out.filter(Boolean).length;
    console.log(`  -> ${okCount}/${(sample || SAMPLE).length} 成功，用时 ${((Date.now() - started) / 1000).toFixed(2)}s`);
    return okCount === (sample || SAMPLE).length;
  } catch (err) {
    if (isRateLimited(err)) {
      rateLimited++;
      console.log('  -> 跳过（免费接口限流）：' + (err.message || err));
      return true;
    }
    console.log('  -> 失败：' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

allOk = await run('免费 Google 接口', Object.assign({}, T.DEFAULTS, { engine: T.ENGINE_GOOGLE })) && allOk;

if (apiKey) {
  allOk = await run('DeepSeek API', Object.assign({}, T.DEFAULTS, {
    engine: T.ENGINE_DEEPSEEK,
    apiKey,
  })) && allOk;
} else {
  console.log('\n=== DeepSeek API ===\n  跳过：未提供 Key（用 --deepseek sk-xxx 或环境变量 DEEPSEEK_API_KEY 启用）');
}

// 划词单条翻译
try {
  process.stdout.write('\n=== 单条划词翻译（Google）===\n');
  const one = await T.translateText('Translation quality matters for reading long articles.', 'zh-CN', {
    settings: Object.assign({}, T.DEFAULTS, { engine: T.ENGINE_GOOGLE }),
  });
  console.log('  -> ' + one);
} catch (err) {
  if (isRateLimited(err)) {
    rateLimited++;
    console.log('  -> 跳过（免费接口限流）');
  } else {
    allOk = false;
    console.log('  -> 失败：' + (err && err.message ? err.message : String(err)));
  }
}

if (allOk && rateLimited) {
  console.log(`\n结果：通过（${rateLimited} 项因免费接口限流被跳过）⚠️`);
  process.exit(2);
}
console.log('\n结果：' + (allOk ? '全部通过 ✅' : '存在失败项 ❌'));
process.exit(allOk ? 0 : 1);
