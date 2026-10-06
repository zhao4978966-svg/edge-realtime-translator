/* =========================================================================
 * tools/e2e-edge.mjs —— 真实浏览器端到端验证
 *
 * 用无头 Edge 加载本扩展并打开一个英文测试页，检查：
 *   1) 内容脚本 + 样式是否注入成功
 *   2) 整页自动翻译是否真的替换了页面文本
 *   3) 页面事件触发的“还原原文”是否能把文本恢复
 *
 * 用法：node tools/e2e-edge.mjs
 * ========================================================================= */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT, findBrowser } from './lib/paths.mjs';

// 可通过环境变量覆盖：DSH_EDGE_PATH（浏览器路径）、E2E_CDP_PORT、E2E_HTTP_PORT、E2E_PROFILE
const BROWSER = findBrowser();
const PROFILE = process.env.E2E_PROFILE || path.join(ROOT, '..', '.e2e-profile');
const PORT = Number(process.env.E2E_CDP_PORT || 9333);
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8791);

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Translation test page</title></head>
<body>
  <h1 id="title">Understanding real-time web page translation</h1>
  <p id="p1">This paragraph should be translated into Chinese by the extension.</p>
  <ul><li id="li1">Fast</li><li id="li2">Reliable</li><li id="li3">Works while scrolling</li></ul>
  <p id="contact">Contact us at support@example.com for more information.</p>
  <p id="hidden" style="display:none">This hidden text must stay untranslated.</p>
  <pre id="code">const answer = "this code must stay as is";</pre>
</body></html>`;

const PAGE_URL = `http://127.0.0.1:${HTTP_PORT}/`;
const SNAPSHOT = `(() => {
  const root = document.getElementById('dsh-translator-root');
  const progress = root && root.querySelector('.dsh-progress');
  const bar = progress && progress.querySelector('.dsh-progress-text');
  const text = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
  return {
    title: text('title'),
    p1: text('p1'),
    li: Array.from(document.querySelectorAll('li')).map(function (n) { return n.textContent; }),
    contact: text('contact'),
    hidden: text('hidden'),
    code: text('code'),
    uiInjected: !!root,
    styledUI: !!progress && getComputedStyle(progress).position === 'fixed',
    progress: bar ? bar.textContent : null,
    progressVisible: !!progress && progress.classList.contains('dsh-show'),
    selectionButton: !!document.querySelector('#dsh-translator-root .dsh-sel-btn'),
    lastError: root ? root.getAttribute('data-dsh-last-error') : null,
    firstBatchAt: root ? root.getAttribute('data-dsh-first-batch') : null,
    elapsedMs: root && root.getAttribute('data-dsh-first-batch')
      ? Date.now() - Number(root.getAttribute('data-dsh-first-batch'))
      : null,
  };
})()`;

/* 内容脚本运行在隔离世界，页面世界看不到它的全局变量，
 * 因此注入检测一律以“DOM 里有没有它插入的界面”为准。 */
const INJECTED_PROBE = `(() => {
  const root = document.getElementById('dsh-translator-root');
  if (!root) return 'none';
  const progress = root.querySelector('.dsh-progress');
  if (!progress) return 'root-only';
  return getComputedStyle(progress).position === 'fixed' ? 'ui+style' : 'ui-no-style';
})()`;

async function waitForDebugger() {  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const tab = list.find((t) => t.type === 'page' && String(t.url).indexOf(`127.0.0.1:${HTTP_PORT}`) >= 0);
      if (tab && tab.webSocketDebuggerUrl) return tab;
    } catch (err) { /* 尚未就绪 */ }
    await sleep(250);
  }
  throw new Error('Edge 调试端口不可用');
}

/** 连到任意 CDP 目标（例如扩展的 service worker）求值一次 */
async function evaluateInTarget(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error('连接失败')));
      setTimeout(() => reject(new Error('连接超时')), 5000);
    });
    const response = await new Promise((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        let message = null;
        try { message = JSON.parse(event.data); } catch (err) { return; }
        if (message.id === 1) {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        }
      });
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }));
      setTimeout(() => reject(new Error('求值超时')), 5000);
    });
    return response && response.result ? response.result.value : '(空)';
  } finally {
    try { socket.close(); } catch (err) { /* 忽略 */ }
  }
}

async function main() {
  if (!BROWSER) {
    console.error('找不到 Edge/Chrome/Chromium。请用环境变量指定，例如：');
    console.error('  PowerShell:  $env:DSH_EDGE_PATH="C:\\path\\to\\msedge.exe"; node tools/e2e-edge.mjs');
    console.error('  bash:        DSH_EDGE_PATH=/usr/bin/microsoft-edge node tools/e2e-edge.mjs');
    process.exitCode = 1;
    return;
  }

  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const server = createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  await new Promise(function (resolve) { server.listen(HTTP_PORT, '127.0.0.1', resolve); });
  console.log('[1/5] 启动无头浏览器并加载扩展…');
  console.log('    浏览器：' + BROWSER);
  const child = spawn(BROWSER, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    PAGE_URL,
  ], { stdio: 'inherit' });

  let ws = null;
  const pending = new Map();
  const consoleMessages = [];
  const isolatedContexts = [];
  let isolatedWorld = null;
  let nextId = 1;

  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('CDP 调用超时：' + method));
      }
    }, 30000);
  });

  const evaluate = async (expression, awaitPromise) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: !!awaitPromise,
      returnByValue: true,
    });
    if (result && result.exceptionDetails) {
      throw new Error('页面脚本异常：' + JSON.stringify(result.exceptionDetails.exception || {}));
    }
    return result && result.result ? result.result.value : undefined;
  };

  try {
    const tab = await waitForDebugger();
    console.log(`    测试页已打开（本地 http 服务 127.0.0.1:${HTTP_PORT}）`);

    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    });
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (err) { return; }
      if (message.method === 'Log.entryAdded' && message.params && message.params.entry) {
        consoleMessages.push('[' + message.params.entry.level + '] ' + message.params.entry.text);
      }
      if (message.method === 'Runtime.exceptionThrown' && message.params && message.params.exceptionDetails) {
        const details = message.params.exceptionDetails;
        consoleMessages.push('[exception] ' + (details.exception && details.exception.description || details.text));
      }
      if (message.method === 'Runtime.executionContextCreated' && message.params && message.params.context) {
        const context = message.params.context;
        if (context.auxData && context.auxData.isDefault === false) {
          isolatedContexts.push(context);
        }
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    await call('Runtime.enable');
    await call('Log.enable').catch(() => {});

    console.log('[2/5] 等待内容脚本注入（以 DOM 界面为准）…');
    let probe = 'none';
    for (let i = 0; i < 40; i++) {
      probe = await evaluate(INJECTED_PROBE);
      if (probe === 'ui+style' || probe === 'ui-no-style') break;
      await sleep(300);
    }
    if (probe !== 'ui+style' && probe !== 'ui-no-style') {
      // 诊断：扩展的 service worker 是否真的加载了，以及扩展自报的名称
      let targets = [];
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = await res.json();
      } catch (err) { targets = []; }
      console.error('    诊断 · 调试目标：\n      ' +
        targets.map((t) => `${t.type} :: ${String(t.url).slice(0, 90)}`).join('\n      '));

      const workers = targets.filter((t) => t.type === 'service_worker');
      for (const worker of workers) {
        try {
          const info = await evaluateInTarget(worker, 'chrome.runtime.getManifest().name + " | " + chrome.runtime.id');
          console.error(`    诊断 · worker ${String(worker.url).slice(0, 60)} => ${info}`);
        } catch (err) {
          console.error(`    诊断 · worker ${String(worker.url).slice(0, 60)} 无法求值：${err.message}`);
        }
      }
      console.error('    诊断 · 页面探针：' + probe);
      console.error('    诊断 · 控制台消息：\n      ' + consoleMessages.slice(-15).join('\n      '));
      throw new Error('内容脚本没有注入：请检查 manifest 的 content_scripts 配置');
    }
    console.log('    ✅ 内容脚本已注入（' + probe + '）');

    // 尝试进入内容脚本的隔离世界，读取它内部的真实状态
    await sleep(600);
    let isoContext = null;
    for (const context of isolatedContexts) {
      try {
        const result = await call('Runtime.evaluate', {
          expression: 'typeof DSHTranslate !== "undefined" && !!window.__DSH_TRANSLATOR_LOADED__',
          contextId: context.id,
          returnByValue: true,
        });
        if (result && result.result && result.result.value === true) { isoContext = context; break; }
      } catch (err) { /* 试下一个 */ }
    }
    console.log('    隔离世界上下文：' + (isoContext ? 'id=' + isoContext.id + ' name=' + isoContext.name : '未找到'));
    if (isoContext) {
      isolatedWorld = isoContext;
      const inside = await call('Runtime.evaluate', {
        expression: `(async () => {
          const before = window.__DSH_TEST__.probe();
          let error = null;
          if (before.queueLen === 0) {
            try { await window.__DSH_TEST__.translate(); } catch (e) { error = (e && e.stack) || String(e); }
          }
          const after = window.__DSH_TEST__.probe();
          return JSON.stringify({ before: before, after: after, error: error, simulate: window.__DSH_TEST__.simulate() });
        })()`,
        contextId: isoContext.id,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log('    隔离世界状态：' + (inside && inside.result ? inside.result.value : JSON.stringify(inside)));
    }

    console.log('[3/5] 等待自动翻译完成（最多 90 秒）…');
    let snapshot = null;
    for (let i = 0; i < 90; i++) {
      snapshot = await evaluate(SNAPSHOT);
      const text = String(snapshot.p1 == null ? '' : snapshot.p1);
      if (i % 10 === 0 && snapshot.firstBatchAt) {
        console.log(`      …已等待 ${(snapshot.elapsedMs / 1000).toFixed(1)}s 进度=${snapshot.progress}` +
          (snapshot.lastError ? ' 错误=' + snapshot.lastError : ''));
      }
      // 翻译完成的标志：正文变成中文，且进度条不再处于“翻译中”
      if (/[\u4e00-\u9fff]/.test(text) && String(snapshot.progress || '').indexOf('翻译中') < 0) break;
      await sleep(1000);
    }

    const cjk = (value) => /[\u4e00-\u9fff]/.test(String(value == null ? '' : value));
    console.log('    页面内容：');
    console.log('      H1  : ' + snapshot.title);
    console.log('      P   : ' + snapshot.p1);
    console.log('      LI  : ' + JSON.stringify(snapshot.li));
    console.log('      MAIL: ' + snapshot.contact);
    console.log('      隐藏: ' + snapshot.hidden);
    console.log('      代码: ' + snapshot.code);
    console.log('      UI  : 根节点=' + snapshot.uiInjected + ' 样式=' + snapshot.styledUI +
      ' 划词按钮=' + snapshot.selectionButton);
    console.log('      进度: ' + snapshot.progress + '（耗时 ' + snapshot.elapsedMs + 'ms）');
    if (snapshot.lastError) console.log('      错误: ' + snapshot.lastError);

    const translatePass = cjk(snapshot.title) && cjk(snapshot.p1) &&
      (snapshot.li || []).some(cjk) && cjk(snapshot.contact);
    // 必须跳过的内容：display:none 的段落、<pre> 代码块
    const skipPass = String(snapshot.hidden).indexOf('This hidden text') === 0 &&
      String(snapshot.code).indexOf('const answer') === 0;
    const uiPass = snapshot.uiInjected === true && snapshot.styledUI === true;
    console.log('[4/5] 整页翻译：' + (translatePass ? '通过 ✅' : '失败 ❌') +
      ' / 跳过隐藏与代码：' + (skipPass ? '通过 ✅' : '失败 ❌') +
      ' / 注入 UI：' + (uiPass ? '通过 ✅' : '失败 ❌'));

    console.log('    触发还原原文（调用内容脚本的真实还原入口）…');
    if (isolatedWorld) {
      const restoreResult = await call('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__DSH_TEST__.restore())',
        contextId: isolatedWorld.id,
        returnByValue: true,
      });
      console.log('    还原接口返回：' + (restoreResult && restoreResult.result ? restoreResult.result.value : ''));
    }
    await sleep(300);
    const afterRestore = isolatedWorld ? await call('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__DSH_TEST__.probe())',
      contextId: isolatedWorld.id,
      returnByValue: true,
    }) : null;
    if (afterRestore) {
      console.log('    还原后内部状态：' + (afterRestore.result ? afterRestore.result.value : ''));
    }
    let restored = null;
    for (let i = 0; i < 30; i++) {
      restored = await evaluate(SNAPSHOT);
      if (!cjk(restored.p1) && String(restored.p1).indexOf('This paragraph') === 0) break;
      await sleep(200);
    }
    const restorePass = String(restored.p1).indexOf('This paragraph') === 0 &&
      String(restored.title).indexOf('Understanding') === 0;
    console.log('    还原后 P: ' + restored.p1);
    console.log('[5/5] 还原原文：' + (restorePass ? '通过 ✅' : '失败 ❌'));

    process.exitCode = translatePass && restorePass && skipPass && uiPass ? 0 : 1;
    console.log(process.exitCode === 0 ? '\n端到端验证：全部通过 ✅' : '\n端到端验证：存在失败项 ❌');
  } catch (err) {
    console.error('E2E 失败：' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (err) { /* 忽略 */ }
    try { child.kill(); } catch (err) { /* 忽略 */ }
    await new Promise(function (resolve) { server.close(resolve); });
    await sleep(700);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
  }
}

await main();
