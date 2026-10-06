# Real-time Web Page Translator (Edge / Chromium extension)

![manifest v3](https://img.shields.io/badge/manifest-v3-blue)
![license MIT](https://img.shields.io/badge/license-MIT-green)
![platform Edge / Chromium](https://img.shields.io/badge/platform-Edge%20%7C%20Chromium-0078D7)

**Repository: `edge-realtime-translator`** · 中文文档见 [README.md](README.md)

A Manifest V3 browser extension that translates web pages **in real time**, right inside the page:

- **Automatic full-page translation** — article text is replaced in place, layout stays intact.
- **Selection translation** — select any text, a small **译** button appears, click it for a translation card with copy-to-clipboard.
- **Dynamic content support** — infinite scroll and SPA route changes keep getting translated.
- **One-click restore** — switch back to the original text at any time.

## Translation engines

| Engine | API key | Notes |
| --- | --- | --- |
| **DeepSeek API** (default) | required | Best quality. Batched requests return a JSON array, so mis-alignment is unlikely. Endpoint and model are configurable (any OpenAI-compatible API works). |
| **Google free endpoint** | none | Zero-config fallback using the undocumented `translate.googleapis.com/translate_a/single` endpoint. |

### ⚠️ About the Google fallback

The Google engine uses an **undocumented, non-official endpoint**. It is included as a *personal convenience
fallback* only:

- It is not a supported Google API and is **not covered by any Google SLA**.
- It is **rate limited** (HTTP 429/403) — the extension backs off and retries, but heavy use will be throttled.
- It may stop working at any time, and using it may be inconsistent with Google's Terms of Service.

**If you use this extension regularly, configure your own DeepSeek (or other OpenAI-compatible) API key.**
The Google endpoint is meant as a safety net when no key is configured — not as a production translation path.

## Install (load unpacked)

1. Open `edge://extensions/` (or `chrome://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin the extension to the toolbar, then **reload any page that was already open**.

## Configure

Open the toolbar popup:

- **Target language** — 19 languages; switching re-translates the current page immediately.
- **Engine** — DeepSeek API or the free Google endpoint.
- **Auto translate on page load** — turn off to translate only on demand.
- **Selection button** — toggle the selection translation UI.
- **DeepSeek API key / base URL / model** — any OpenAI-compatible endpoint works.
- **Test API** button — verifies the endpoint before you rely on it.

## Usage

| Action | Result |
| --- | --- |
| Open a page | Translated automatically (if enabled) |
| Popup → *Translate current page* | Translate / re-translate on demand |
| Popup → *Restore original* | Revert to the original text immediately |
| Select text | A **译** button appears; click it for the translation card |
| Right-click a selection → *Translate selection* | Same, result shown in the popup |
| Right-click page → *Translate page / Restore page* | Context menu shortcuts |
| `Alt+Shift+T` | Toggle translate / restore (rebindable in `edge://extensions/shortcuts`) |

A small pill at the bottom of the page reports progress (`翻译中 12/48`, `已翻译 36 段`) and fades out.

## How it works

- **Text nodes only.** The extension never rewrites `innerHTML`, so event listeners, framework rendering
  (React/Vue) and page layout are untouched.
- **Originals in memory.** A `WeakMap` maps each text node to its original string; *restore* writes them back.
  No marker attributes are added to the page (except the extension's own UI container).
- **Skipped content.** `script`/`style`/`code`/`pre`/`textarea`/inputs, `display:none` and `visibility:hidden`
  nodes, `translate="no"` / `.notranslate` regions, and text without letters or digits.
- **No duplicate work.** A translation cache plus in-flight de-duplication; a `lastApplied` map marks the
  extension's own writes so its output is never mistaken for source text (this was a real bug found by the
  end-to-end test — see `tools/e2e-edge.mjs`).
- **Batching.** Batches of ≤12 items / ≤2200 characters, 3 concurrent workers. A failed batch is retried
  item-by-item so one bad string cannot poison the batch.
- **Long paragraphs.** Text over 1200 characters is split at sentence boundaries, translated, and joined
  back into the same text node.
- **Language awareness.** When the target is Chinese and the page is already Chinese, auto-translation is skipped.

## Project layout

```
manifest.json            MV3 manifest
background.js            service worker: context menus, shortcuts, message routing
lib/translator.js        engines: DeepSeek + Google, cache, batching, backoff
lib/content.js           in-page engine: DOM scan, MutationObserver, selection UI
lib/content.css          injected UI styles (all dsh- prefixed)
popup/                   toolbar settings panel
icons/                   generated PNG icons
tools/                   dev-only scripts (not part of the extension)
  validate.mjs           static checks used by CI
  test-engines.mjs       live engine test
  test-longtext.mjs      long-text chunking regression
  test-fallback.mjs      DeepSeek failure / fallback behaviour
  e2e-edge.mjs           real headless browser test (loads the extension)
  make_icons.py          regenerate icons
```

## Development

```bash
npm run check          # static validation (syntax, manifest, icons, secrets)
npm run test:engines   # live translation test (needs network)
npm run test:fallback  # fallback / error-path test (needs network)
npm run test:e2e       # headless Edge end-to-end test
```

Notes:

- `test:engines` accepts a key: `node tools/test-engines.mjs --deepseek sk-...`.
- Behind a proxy, Node's `fetch` needs `HTTPS_PROXY`/`HTTP_PROXY` **and** `NODE_USE_ENV_PROXY=1`.
- `test:e2e` needs Edge/Chrome/Chromium; override the path with `DSH_EDGE_PATH`.
  It launches a browser, so it cannot run inside a restrictive sandbox.
- Exit code `2` means "skipped because the free Google endpoint was rate limited" — not a code failure.

## License

[MIT](LICENSE)
