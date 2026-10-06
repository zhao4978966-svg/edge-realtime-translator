/* =========================================================================
 * tools/validate.mjs —— 提交前的静态校验（CI 也用这个）
 *
 * 检查内容：
 *   1) 所有 .js 文件语法可解析（用 node:vm 编译，不执行）
 *   2) manifest.json 合法，且引用的每个文件都真实存在
 *   3) 图标是有效的 PNG（尺寸与 manifest 声明一致）
 *   4) 源码里没有硬编码的 API Key
 *
 * 用法：node tools/validate.mjs
 * ========================================================================= */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);

/* ------------------------------ 1. JS 语法 ------------------------------ */

let jsCount = 0;
let esmSkipped = 0;

/** 语法检查：.js 按脚本编译；.mjs 按 ES 模块编译（需要 Node 的 vm 模块支持） */
function checkSyntax(file) {
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.mjs')) {
    if (typeof vm.SourceTextModule !== 'function') {
      esmSkipped++;
      return;
    }
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(source, { identifier: file });
    return;
  }
  // eslint-disable-next-line no-new
  new vm.Script(source, { filename: file });
}

for (const file of files.filter((f) => /\.(js|mjs)$/.test(f))) {
  try {
    checkSyntax(file);
    jsCount++;
  } catch (err) {
    fail(`语法错误 ${rel(file)}：${err.message}`);
  }
}
console.log(`[1/4] 语法检查：${jsCount} 个 JS 文件通过` +
  (esmSkipped ? `（${esmSkipped} 个 .mjs 已跳过，需 Node 支持 vm.SourceTextModule）` : ''));

/* ----------------------------- 2. manifest ----------------------------- */

const manifestPath = path.join(ROOT, 'manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`manifest.json 解析失败：${err.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
  for (const key of ['name', 'version', 'description']) {
    if (!manifest[key]) fail(`manifest 缺少字段：${key}`);
  }

  const referenced = new Set([
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean));
  if (manifest.default_locale) {
    referenced.add(path.posix.join('_locales', manifest.default_locale, 'messages.json'));
  }

  for (const item of referenced) {
    const full = path.join(ROOT, item);
    try {
      statSync(full);
    } catch (err) {
      fail(`manifest 引用的文件不存在：${item}`);
    }
  }
  console.log(`[2/4] manifest：引用 ${referenced.size} 个文件，缺失 ${problems.length} 个`);
}

/* ------------------------------- 3. 图标 ------------------------------- */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const iconEntries = Object.entries(manifest?.icons || {});
for (const [size, file] of iconEntries) {
  const full = path.join(ROOT, file);
  let buffer = null;
  try {
    buffer = readFileSync(full);
  } catch (err) {
    continue; // 缺失已在第 2 步报过
  }
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    fail(`图标不是有效 PNG：${file}`);
    continue;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== Number(size) || height !== Number(size)) {
    fail(`图标尺寸不符：${file} 是 ${width}x${height}，manifest 声明 ${size}`);
  }
}
console.log(`[3/4] 图标检查：${iconEntries.length} 个`);

/* ---------------------------- 4. 敏感信息 ---------------------------- */

const SECRET_RE = /(sk-[A-Za-z0-9]{16,})|(AIza[0-9A-Za-z_-]{20,})|(ghp_[A-Za-z0-9]{20,})/;
let secretHits = 0;
for (const file of files.filter((f) => /\.(js|mjs|json|html|md|py)$/.test(f))) {
  // 测试脚本里的假 Key 属于有意为之，需带 sk-invalid / sk-test 前缀
  const source = readFileSync(file, 'utf8');
  const match = source.match(SECRET_RE);
  if (match && !/sk-(invalid|test|your|xxx)/i.test(match[0])) {
    fail(`疑似硬编码密钥：${rel(file)} -> ${match[0].slice(0, 12)}…`);
    secretHits++;
  }
}
console.log(`[4/4] 敏感信息：发现 ${secretHits} 处`);

/* ------------------------------- 结果 ------------------------------- */

if (problems.length) {
  console.error('\n校验失败：');
  for (const item of problems) console.error('  - ' + item);
  process.exit(1);
}
console.log('\n全部校验通过 ✅');
