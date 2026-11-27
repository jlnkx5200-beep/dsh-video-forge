/**
 * 色彩与版式的唯一来源。
 *
 * P2-2：组件里**一个十六进制色值都不许出现**，全部走 `var(--vf-*)`；
 *       hex 只允许出现在本文件的变量定义里（并且深/浅两套由 prefers-color-scheme 决定）。
 * P2-3：不再对每个 input 撒 `colorScheme: 'dark light'` 补丁 —— 由 `color-scheme` 变量统一声明。
 * P2-1：网格用 auto-fit + minmax，侧栏一窄就自动降列，不写死两列。
 * P2-4：:focus-visible 全局可见焦点环；tab/tablist/dialog 的样式随 ARIA 状态走。
 */

const STYLE_ID = 'dsh-video-forge-theme'

const CSS = `
.vf-root {
  color-scheme: dark light;
  --vf-bg: #080b12;
  --vf-bg-soft: #0d121c;
  --vf-bg-elev: #121927;
  --vf-bg-hover: #17202f;
  --vf-border: #22303f;
  --vf-border-strong: #33465c;
  --vf-text: #e6edf6;
  --vf-text-dim: #9fb0c4;
  --vf-text-muted: #6d7f93;
  --vf-accent: #4f8cff;
  --vf-accent-soft: rgba(79, 140, 255, 0.16);
  --vf-ok: #43c08a;
  --vf-warn: #e2a33c;
  --vf-danger: #ef5f6b;
  --vf-mock-a: #3a2a08;
  --vf-mock-b: #4a350c;
  --vf-mock-line: #e2a33c;
  --vf-shadow: 0 1px 0 rgba(255, 255, 255, 0.03), 0 8px 24px -12px rgba(0, 0, 0, 0.7);
  --vf-radius: 10px;
  --vf-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  .vf-root {
    --vf-bg: #f7f9fc;
    --vf-bg-soft: #ffffff;
    --vf-bg-elev: #ffffff;
    --vf-bg-hover: #eef2f8;
    --vf-border: #d8e0ea;
    --vf-border-strong: #b6c3d3;
    --vf-text: #16202c;
    --vf-text-dim: #4d5f74;
    --vf-text-muted: #7c8b9c;
    --vf-accent: #2f6fe4;
    --vf-accent-soft: rgba(47, 111, 228, 0.12);
    --vf-ok: #1f8f60;
    --vf-warn: #a56a11;
    --vf-danger: #c3333f;
    --vf-mock-a: #fff5dd;
    --vf-mock-b: #ffe9b8;
    --vf-mock-line: #a56a11;
    --vf-shadow: 0 1px 0 rgba(0, 0, 0, 0.02), 0 10px 24px -18px rgba(16, 32, 52, 0.45);
  }
}
.vf-root, .vf-root * { box-sizing: border-box; }
.vf-root {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px 18px; min-height: 0; overflow-y: auto;
  background: var(--vf-bg); color: var(--vf-text);
  font: 400 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.vf-root :focus-visible {
  outline: 2px solid var(--vf-accent);
  outline-offset: 2px;
  border-radius: 6px;
}
.vf-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); align-items: start; }
.vf-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.vf-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.vf-card {
  background: var(--vf-bg-soft); border: 1px solid var(--vf-border);
  border-radius: var(--vf-radius); padding: 10px 12px; box-shadow: var(--vf-shadow);
  min-width: 0;
}
.vf-card-title { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--vf-text-dim); }
.vf-dim { color: var(--vf-text-dim); }
.vf-muted { color: var(--vf-text-muted); }
.vf-mono { font-family: var(--vf-mono); }
.vf-btn {
  appearance: none; cursor: pointer; border-radius: 8px;
  border: 1px solid var(--vf-border-strong); background: var(--vf-bg-elev); color: var(--vf-text);
  padding: 5px 11px; font: inherit; font-size: 12px; line-height: 1.4;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
.vf-btn:hover:not(:disabled) { background: var(--vf-bg-hover); }
.vf-btn:disabled { opacity: .45; cursor: not-allowed; }
.vf-btn-primary { background: var(--vf-accent); border-color: var(--vf-accent); color: #fff; font-weight: 600; }
.vf-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.vf-btn-danger { border-color: var(--vf-danger); color: var(--vf-danger); }
.vf-btn-danger:hover:not(:disabled) { background: var(--vf-danger); color: #fff; }
.vf-input, .vf-select, .vf-textarea {
  width: 100%; min-width: 0; font: inherit; font-size: 12px;
  color: var(--vf-text); background: var(--vf-bg-elev);
  border: 1px solid var(--vf-border); border-radius: 8px; padding: 6px 8px;
}
.vf-textarea { font-family: var(--vf-mono); font-size: 11.5px; line-height: 1.6; resize: vertical; min-height: 96px; }
.vf-input::placeholder, .vf-textarea::placeholder { color: var(--vf-text-muted); }
.vf-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vf-border); padding-bottom: 6px; flex-wrap: wrap; }
.vf-tab {
  appearance: none; cursor: pointer; font: inherit; font-size: 12px;
  padding: 5px 11px; border-radius: 7px 7px 0 0; border: 1px solid transparent;
  background: transparent; color: var(--vf-text-dim);
}
.vf-tab:hover { background: var(--vf-bg-hover); color: var(--vf-text); }
.vf-tab[aria-selected="true"] {
  background: var(--vf-bg-elev); border-color: var(--vf-border); border-bottom-color: var(--vf-bg-elev);
  color: var(--vf-text); font-weight: 600;
}
.vf-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .03em;
  padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--vf-border-strong); color: var(--vf-text-dim);
}
.vf-badge-ok { border-color: var(--vf-ok); color: var(--vf-ok); }
.vf-badge-warn { border-color: var(--vf-warn); color: var(--vf-warn); }
.vf-badge-danger { border-color: var(--vf-danger); color: var(--vf-danger); }
.vf-badge-accent { border-color: var(--vf-accent); color: var(--vf-accent); }
.vf-alert {
  display: flex; gap: 8px; align-items: flex-start;
  border: 1px solid var(--vf-border); border-left-width: 3px;
  border-radius: 8px; padding: 7px 10px; font-size: 12px;
  background: var(--vf-bg-elev); color: var(--vf-text);
}
.vf-alert-danger { border-left-color: var(--vf-danger); }
.vf-alert-warn { border-left-color: var(--vf-warn); }
.vf-alert-ok { border-left-color: var(--vf-ok); }
.vf-alert-info { border-left-color: var(--vf-accent); }
.vf-alert-title { font-weight: 700; }
.vf-stale { opacity: .72; filter: grayscale(.55); }
.vf-mock-stripes {
  border: 1px solid var(--vf-mock-line);
  background-image: repeating-linear-gradient(135deg, var(--vf-mock-a) 0 10px, var(--vf-mock-b) 10px 20px);
  color: var(--vf-text); font-weight: 600;
}
.vf-thumb {
  width: 100%; height: 108px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--vf-border); background: var(--vf-bg-elev); cursor: zoom-in;
}
.vf-thumb-empty {
  display: flex; align-items: center; justify-content: center; text-align: center;
  font-size: 10.5px; color: var(--vf-text-muted);
}
.vf-lightbox {
  position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center;
  background: rgba(4, 6, 10, .82); padding: 24px; cursor: zoom-out;
}
.vf-lightbox-inner { position: relative; max-width: min(92vw, 1280px); max-height: 88vh; display: flex; flex-direction: column; gap: 8px; }
.vf-lightbox-media { max-width: 100%; max-height: 76vh; border-radius: 10px; background: #000; }
.vf-lightbox-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: #e6edf6; font-size: 12px; }
.vf-scroll { max-height: 320px; overflow: auto; }
.vf-kv { display: grid; grid-template-columns: minmax(96px, auto) 1fr; gap: 2px 10px; font-size: 11.5px; }
.vf-kv > span:nth-child(odd) { color: var(--vf-text-muted); }
.vf-code { font-family: var(--vf-mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-all; color: var(--vf-text-dim); }
.vf-details > summary { cursor: pointer; font-size: 11px; color: var(--vf-text-muted); }
.vf-progress { height: 4px; border-radius: 999px; background: var(--vf-bg-hover); overflow: hidden; }
.vf-progress > i { display: block; height: 100%; background: var(--vf-accent); transition: width .25s ease; }
.vf-shot-row { display: grid; gap: 6px; grid-template-columns: 54px 1fr; align-items: start; }
.vf-scroll-x { overflow-x: auto; }
`

let injected = false

/** 幂等注入主题（多次挂载不会重复插入 style 节点）。 */
export function injectTheme(): void {
  if (injected) return
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) {
    injected = true
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  injected = true
}

/** 热卸载时清掉 style，避免面板反复卸载/挂载后残留。 */
export function disposeTheme(): void {
  injected = false
  if (typeof document === 'undefined') return
  document.getElementById(STYLE_ID)?.remove()
}
