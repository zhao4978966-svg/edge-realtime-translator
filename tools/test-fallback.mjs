/* 验证 DeepSeek 失败时的兜底行为与错误信息 */
import { loadTranslator } from './lib/paths.mjs';

const T = loadTranslator();

const SAMPLE = ['Good morning, have a nice day.'];
const failures = [];
let rateLimited = 0;
const check = (label, ok) => { if (!ok) failures.push(label); };
const isRateLimited = (err) => /限流|HTTP 429|HTTP 403/.test(String((err && err.message) || err));

console.log('用例 1：Key 无效 -> 应自动回落到 Google 并给出译文');
try {
  const out = await T.translateBatch(SAMPLE, 'zh-CN', {
    settings: Object.assign({}, T.DEFAULTS, { engine: T.ENGINE_DEEPSEEK, apiKey: 'sk-invalid-key-for-test' }),
  });
  console.log('  结果:', out[0]);
  check('用例1 兜底', !!out[0]);
  console.log('  ' + (out[0] ? '通过 ✅' : '失败 ❌'));
} catch (err) {
  if (isRateLimited(err)) {
    rateLimited++;
    console.log('  跳过（免费接口限流）：' + String(err.message).slice(0, 80));
  } else {
    console.log('  抛出异常:', err.message);
    check('用例1 兜底', false);
    console.log('  失败 ❌（本应回落到 Google）');
  }
}

console.log('\n用例 2：Key 无效且禁用兜底 -> 应抛出包含主引擎原因的异常');
// 清空缓存，避免命中上一个用例的结果而跳过真实请求
T.clearCache();
try {
  await T.translateBatch(SAMPLE, 'zh-CN', {
    settings: Object.assign({}, T.DEFAULTS, {
      engine: T.ENGINE_DEEPSEEK,
      apiKey: 'sk-invalid-key-for-test',
      allowGoogleFallback: false,
    }),
  });
  console.log('  失败 ❌（应当抛异常）');
  check('用例2 禁用兜底', false);
} catch (err) {
  console.log('  异常信息:', String(err.message).slice(0, 160));
  check('用例2 禁用兜底', true);
  console.log('  通过 ✅');
}

console.log('\n用例 3：无 Key -> 应立即使用 Google，不产生报错');
try {
  const out = await T.translateBatch(SAMPLE, 'ja', {
    settings: Object.assign({}, T.DEFAULTS, { engine: T.ENGINE_DEEPSEEK, apiKey: '' }),
  });
  console.log('  结果:', out[0]);
  check('用例3 无 Key 兜底', !!out[0]);
  console.log('  ' + (out[0] ? '通过 ✅' : '失败 ❌'));
} catch (err) {
  if (isRateLimited(err)) {
    rateLimited++;
    console.log('  跳过（免费接口限流）');
  } else {
    console.log('  抛出异常:', err.message, '失败 ❌');
    check('用例3 无 Key 兜底', false);
  }
}

if (failures.length) {
  console.log('\n结果：存在失败项 ❌ ' + failures.join('、'));
  process.exit(1);
}
if (rateLimited) {
  console.log(`\n结果：通过（${rateLimited} 项因免费接口限流被跳过）⚠️`);
  process.exit(2);
}
console.log('\n结果：全部通过 ✅');
process.exit(0);
