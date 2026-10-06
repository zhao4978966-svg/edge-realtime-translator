# 实时网页翻译（Edge 扩展）

A real-time web page translator for Microsoft Edge / Chromium.
**English documentation: [README.en.md](README.en.md)** · License: [MIT](LICENSE)

一个可以直接装在 **Microsoft Edge** 里的浏览器扩展，用来做**网页实时翻译**：

- **整页自动翻译**：打开英文（或任意外语）页面，正文自动替换成中文，版式不变。
- **划词即时翻译**：选中任意文字，旁边弹出一个「译」按钮，点一下出译文卡片，可一键复制。
- **动态内容跟随翻译**：无限滚动、单页应用（SPA）新加载出来的内容会自动接着翻译。
- **一键还原**：随时切回原文，不做任何破坏性修改（只改文本节点，不动页面结构）。

翻译引擎有两种，随时可切换：

| 引擎                   | 是否需要 Key | 说明                                          |
| -------------------- | -------- | ------------------------------------------- |
| **DeepSeek API**（默认） | 需要       | 质量最好，批量翻译时按 JSON 数组返回，串位风险低，支持自定义接口地址和模型    |
| **Google 免费接口**      | 不需要      | 零配置兜底，用的是**未文档化**的 `translate.googleapis.com/translate_a/single` 端点 |

> DeepSeek 调用失败或没填 Key 时**会自动回落到 Google**，所以页面不会因为没配置就完全用不了。

### ⚠️ 关于 Google 兜底的说明

Google 引擎走的是**未文档化的非官方端点**，定位只是"没配 Key 时的临时兜底"：

- 它不是 Google 官方支持的 API，**没有任何稳定性承诺**；
- 会被**限流**（HTTP 429/403），扩展会自动退避重试，但高频使用必然被掐；
- 随时可能失效，且这种用法可能与 Google 的服务条款不一致。

**长期使用请配置自己的 DeepSeek（或任意 OpenAI 兼容）API Key。**

<!-- 建议补一张演示截图：把文件放到 docs/screenshot.png，然后取消下面一行的注释 -->
<!-- ![演示](docs/screenshot.png) -->

---

## 一、安装（只需做一次）

1. 在 Edge 地址栏输入 `edge://extensions/` 回车。
2. 打开左下角的 **开发人员模式**（Developer mode）。
3. 点 **加载解压缩的扩展**（Load unpacked）。
4. 选择这个文件夹：
   `edge-translator`（也就是本文件所在的目录，里面能看到 `manifest.json`）。
5. 扩展列表里出现「**实时网页翻译 (DeepSeek / Google)**」就装好了。
   建议点工具栏的拼图图标 → 把该扩展 **固定** 到工具栏，方便随时点开。
6. **装好后请刷新一下已经打开的网页**（内容脚本只对刷新后的页面生效）。

## 二、配置 DeepSeek（可选，但推荐）

1. 点工具栏上的扩展图标，打开设置面板。
2. 在「DeepSeek 配置」里填入 **API Key**（`sk-...`，在 https://platform.deepseek.com 申请）。
3. 点「**测试接口**」按钮，看到「接口正常」就说明配置成功。
4. 不填 Key 也能用：面板会提示当前自动使用免费 Google 接口。

其他可调项：

- **翻译成**：简体中文 / 繁體中文 / English / 日本語 / 한국어 等 19 种语言，切换后会立即重新翻译当前页面。
- **打开页面自动翻译**：关掉后只在你点「翻译当前页面」时才翻译。
- **划词翻译悬浮按钮**：关掉后选中文字不再弹按钮。
- **调试日志**：打开后按 F12 能在控制台看到翻译过程的日志。

## 三、使用

| 操作                     | 效果                                                 |
| ---------------------- | -------------------------------------------------- |
| 打开网页                   | 自动整页翻译（可在面板关闭）                                     |
| 点扩展图标 →「翻译当前页面」        | 手动翻译 / 重新翻译                                        |
| 点扩展图标 →「还原原文」          | 立刻恢复原文                                             |
| 选中文字                   | 出现「译」按钮，点击弹出译文卡片                                   |
| 选中文字 → 右键 →「翻译选中文字」    | 同上（不弹卡片，结果在面板里显示）                                  |
| 右键页面 →「翻译整个页面 / 还原为原文」 | 右键菜单操作                                             |
| 快捷键 `Alt+Shift+T`      | 当前页面翻译 / 还原切换（可在 `edge://extensions/shortcuts` 改键） |

页面底部中间会有一个圆形提示条，显示「翻译中 12/48」或「已翻译 36 段」，几秒后自动淡出。

---

## 四、实现要点

- **只改文本节点**：不替换 `innerHTML`，因此不会破坏站点的事件绑定、React/Vue 的渲染和页面布局。
- **原文保存在内存里**：使用 `WeakMap` 按文本节点记录原文，「还原原文」时逐节点写回；不会往页面上写任何标记属性（除了扩展自己的 UI 容器）。
- **自动跳过不该翻译的内容**：`script`/`style`/`code`/`pre`/`textarea`/输入框、`display:none` 与 `visibility:hidden` 的隐藏节点、`translate="no"` 或 `.notranslate` 标记的区域、纯数字/符号文本。
- **不重复翻译**：内置译文缓存（同一句话在不同页面/位置只请求一次）+ 请求去重；并用 `lastApplied` 识别「自己写入的译文」，避免把自己的译文误当成原文覆盖掉。
- **批量与并发控制**：按「条数 ≤ 12 且字符数 ≤ 2200」组批，3 个并发 worker；整批失败时自动拆成单条重试，避免一条坏数据拖垮整批。
- **超长段落**：超过 1200 字符的段落按句子边界切块翻译后再拼回同一个文本节点，不会丢内容。
- **语言自适应**：目标语言是中文、且页面本来就是中文（`lang` 属性或中文字符占比判断）时，不启动自动翻译。
- **同源限制之外无副作用**：只申请了 `storage / contextMenus / activeTab / tabs / scripting` 权限，翻译文本只会发往你选择的那个翻译服务。

## 五、目录结构

```
edge-translator/
├─ manifest.json            # 扩展清单（MV3）
├─ background.js            # Service Worker：右键菜单、快捷键、消息转发
├─ LICENSE                  # MIT
├─ README.md / README.en.md # 中文 / 英文说明
├─ package.json             # 仅用于脚本入口（无运行时依赖）
├─ lib/
│  ├─ translator.js         # 翻译引擎（DeepSeek / Google 免费接口、缓存、组批、退避重试）
│  ├─ content.js            # 页面内翻译：DOM 扫描、动态监听、划词翻译 UI
│  └─ content.css           # 注入页面的 UI 样式（全部 dsh- 前缀，避免冲突）
├─ popup/                   # 工具栏设置面板
│  ├─ popup.html
│  ├─ popup.css
│  └─ popup.js
├─ icons/                   # 16/32/48/128 图标（由 tools/make_icons.py 生成）
├─ .github/workflows/       # CI：提交时跑静态校验
└─ tools/                   # 开发自测脚本，安装扩展不需要用到
   ├─ validate.mjs          # 静态校验（语法 / manifest / 图标 / 密钥），CI 用这个
   ├─ lib/paths.mjs         # 共用：定位项目文件与浏览器，不写死本机路径
   ├─ make_icons.py         # 重新生成图标
   ├─ test-engines.mjs      # 在 Node 里实测两种引擎
   ├─ test-longtext.mjs     # 长文本切块拼接回归
   ├─ test-fallback.mjs     # DeepSeek 失败时的兜底行为
   └─ e2e-edge.mjs          # 无头浏览器端到端验证（真实加载扩展翻译测试页）
```

## 六、自测脚本（可选）

```powershell
npm run check          # 静态校验（无需联网）
npm run test:engines   # 实测翻译引擎（需要联网）
npm run test:fallback  # 兜底与错误路径
npm run test:e2e       # 无头浏览器端到端

# 等价的手工调用
node --experimental-vm-modules tools/validate.mjs
node tools/test-engines.mjs --deepseek sk-你的key
node tools/e2e-edge.mjs
```

> - 网络需要代理时：设置 `HTTPS_PROXY` / `HTTP_PROXY`（例如 `http://127.0.0.1:7900`）**并加** `NODE_USE_ENV_PROXY=1`，Node 的 `fetch` 才会走代理。Edge 自身按系统代理设置走。
> - `e2e-edge.mjs` 会自动查找 Edge/Chrome/Chromium，可用 `DSH_EDGE_PATH` 指定路径；它需要创建命名管道，在受限沙箱里可能报 `FATAL: platform_channel` 而无法启动，这是环境限制，不是扩展问题。
> - 脚本退出码 `2` 表示"免费 Google 接口被限流，用例跳过"，**不是代码失败**。

## 七、常见问题

**装好后页面没反应？**
刷新页面。扩展安装前就已打开的标签页不会自动注入内容脚本（点面板按钮时会尝试动态注入，但刷新最稳妥）。

**某些内容没翻译？**
可能是：节点被隐藏（`display:none`，展开后才翻译）、在 `<code>/<pre>/<textarea>` 里、带 `.notranslate`、或是纯数字/符号。按 F12 在控制台执行 `window.__DSH_TEST__.probe()` 可以看到各文本节点被跳过的原因。

**页面报 401 / 「接口返回 401」？**
API Key 无效或余额不足。清空 Key 就会走免费 Google 接口。

**翻译很慢或部分失败？**
免费 Google 接口对高频请求会限流（HTTP 429/403）。扩展会自动退避重试最多 3 次，连续失败时面板和页面提示会明确写出"接口被限流，请配置 DeepSeek API Key"。**长期使用建议配置自己的 Key**；也可以在面板里关掉「打开页面自动翻译」，改为按需翻译。

**会不会把我正在编辑的输入框内容改掉？**
不会。`input`/`textarea`/`contenteditable` 一律跳过。

## 八、开源许可

[MIT](LICENSE)。使用免费 Google 端点所带来的风险由使用者自行承担，详见上文「关于 Google 兜底的说明」。
