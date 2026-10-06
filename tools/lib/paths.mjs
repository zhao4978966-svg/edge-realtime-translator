/* =========================================================================
 * tools/lib/paths.mjs —— 测试脚本共用：定位项目文件与浏览器
 * 不写死任何本机路径，clone 下来即可在不同机器上运行。
 * ========================================================================= */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（即 manifest.json 所在目录） */
export const ROOT = path.resolve(TOOLS_DIR, '..', '..');

/** 翻译引擎库路径 */
export const LIB_PATH = path.join(ROOT, 'lib', 'translator.js');

/** 把 lib/translator.js 挂到 globalThis，模拟内容脚本环境 */
export function loadTranslator() {
  const source = readFileSync(LIB_PATH, 'utf8');
  new Function('globalThis', source)(globalThis);
  return globalThis.DSHTranslate;
}

const EDGE_CANDIDATES = [
  process.env.DSH_EDGE_PATH,
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/** 找出可用的 Chromium 内核浏览器；可用 DSH_EDGE_PATH 覆盖 */
export function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch (err) { /* 继续找 */ }
  }
  return null;
}
