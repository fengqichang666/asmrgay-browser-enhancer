export const PANEL_STYLES = `
  :host { all: initial; color-scheme: light; }
  * { box-sizing: border-box; letter-spacing: 0; }
  button, input, select { font: inherit; }
  .abe-launcher {
    position: fixed; left: 18px; bottom: 84px; z-index: 2147483646;
    width: 46px; height: 46px; border: 0; border-radius: 8px;
    background: #1769aa; color: white; box-shadow: 0 4px 16px rgba(0,0,0,.24);
    cursor: pointer; font: 700 16px/1 system-ui, sans-serif;
  }
  .abe-launcher:hover { background: #0f568e; }
  .abe-panel {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 2147483647;
    width: min(var(--abe-panel-width, 560px), 100vw); background: #f7f8fa; color: #20242a;
    border-right: 1px solid #cfd5dc; box-shadow: 8px 0 28px rgba(0,0,0,.18);
    display: grid; grid-template-rows: auto auto auto auto auto minmax(0, 1fr) auto; font: 14px/1.4 system-ui, sans-serif;
  }
  .abe-hidden { display: none !important; }
  .abe-header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #fff; border-bottom: 1px solid #dfe3e8; }
  .abe-title { min-width: 0; flex: 1; }
  .abe-title strong { display: block; font-size: 16px; }
  .abe-path { display: block; color: #69717c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abe-icon-button { width: 34px; height: 34px; border: 1px solid #c9d0d8; background: white; color: #303740; border-radius: 6px; cursor: pointer; }
  .abe-icon-button:hover { background: #edf1f5; }
  .abe-toolbar { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px; padding: 7px 10px; background: #fff; border-bottom: 1px solid #e1e5e9; }
  .abe-primary { min-height: 30px; border: 0; border-radius: 5px; padding: 5px 9px; background: #1769aa; color: white; cursor: pointer; white-space: nowrap; }
  .abe-primary:disabled { opacity: .55; cursor: default; }
  .abe-progress { color: #4c5661; white-space: nowrap; font-size: 12px; }
  .abe-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abe-data-menu { position: relative; }
  .abe-data-menu summary { min-height: 30px; border: 1px solid #bac3cc; border-radius: 5px; background: #fff; color: #303942; padding: 5px 8px; cursor: pointer; list-style: none; white-space: nowrap; }
  .abe-data-menu summary::-webkit-details-marker { display: none; }
  .abe-data-menu summary::after { content: " ▾"; color: #78818a; }
  .abe-data-menu[open] summary { background: #edf1f5; }
  .abe-data-actions { position: absolute; top: calc(100% + 6px); right: 0; z-index: 10; width: 300px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 9px; background: #fff; border: 1px solid #cbd2d9; border-radius: 7px; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
  .abe-secondary { min-height: 30px; border: 1px solid #bac3cc; border-radius: 5px; background: #fff; color: #303942; padding: 4px 7px; cursor: pointer; }
  .abe-secondary:hover { background: #edf1f5; }
  .abe-secondary:disabled { opacity: .55; cursor: default; }
  .abe-auto-scan { background: #f4f7f9; border-bottom: 1px solid #dfe3e8; }
  .abe-auto-scan summary { padding: 7px 10px; color: #303942; cursor: pointer; font-weight: 600; }
  .abe-auto-scan-body { display: grid; gap: 7px; padding: 0 10px 9px; }
  .abe-auto-scan-fields { display: grid; grid-template-columns: minmax(0, 1fr) 108px; gap: 7px; }
  .abe-auto-scan-fields label { display: grid; gap: 3px; color: #69717c; font-size: 12px; }
  .abe-auto-scan-fields input { width: 100%; min-height: 30px; border: 1px solid #bcc5cf; border-radius: 5px; background: #fff; color: #20242a; padding: 4px 7px; }
  .abe-auto-scan-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .abe-scan-progress { color: #69717c; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abe-import-mode { min-height: 30px; border: 1px solid #bac3cc; border-radius: 5px; background: #fff; color: #303942; padding: 4px 6px; }
  .abe-clear { color: #9b2f2f; border-color: #d7b5b5; }
  .abe-controls { display: grid; grid-template-columns: minmax(0, 1fr) 100px auto auto; gap: 7px; padding: 7px 10px; background: #fff; border-bottom: 1px solid #dfe3e8; }
  .abe-controls input, .abe-controls select { width: 100%; min-height: 32px; border: 1px solid #bcc5cf; border-radius: 5px; background: white; color: #20242a; padding: 5px 8px; }
  .abe-breadcrumbs { padding: 7px 14px; background: #fff; border-bottom: 1px solid #e0e4e8; white-space: nowrap; overflow-x: auto; }
  .abe-breadcrumbs button { border: 0; background: transparent; color: #1769aa; padding: 2px 0; cursor: pointer; }
  .abe-breadcrumbs span { color: #8a929b; }
  .abe-load-more, .abe-tree-error { display: block; width: 100%; height: 49px; border: 0; border-bottom: 1px solid #e0e5ea; background: #f5f8fa; color: #1769aa; padding-right: 14px; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abe-load-more:hover { background: #edf4f9; }
  .abe-tree-loading { height: 49px; padding-top: 14px; padding-right: 14px; border-bottom: 1px solid #e0e5ea; background: #fafbfc; color: #69717c; }
  .abe-tree-error { color: #a13b35; background: #fff6f5; padding-top: 14px; }
  .abe-tree-error:hover { background: #fbeae8; }
  .abe-list { overflow: auto; overflow-anchor: none; padding: 6px 0; }
  .abe-resize-handle { position: absolute; top: 0; right: -4px; bottom: 0; z-index: 2; width: 8px; cursor: col-resize; touch-action: none; }
  .abe-resize-handle::after { content: ""; position: absolute; top: 50%; left: 3px; width: 2px; height: 48px; transform: translateY(-50%); border-radius: 2px; background: #c7d0d8; opacity: 0; transition: opacity .15s ease; }
  .abe-resize-handle:hover::after, .abe-resize-handle:focus-visible::after, .abe-resize-handle.abe-resizing::after { opacity: 1; }
  .abe-empty { padding: 32px 20px; text-align: center; color: #69717c; }
  .abe-player { padding: 10px; border-top: 1px solid #cbd5df; background: #fff; box-shadow: 0 -3px 12px rgba(0,0,0,.08); }
  .abe-player-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .abe-player-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .abe-player .abe-icon-button { flex: 0 0 auto; width: 28px; height: 28px; }
  .abe-audio { display: block; width: 100%; height: 36px; }
  .abe-row { display: grid; grid-template-columns: 28px minmax(0,1fr) 160px; align-items: center; min-height: 48px; padding: 4px 10px 4px 14px; border-bottom: 1px solid #e5e8ec; background: #fff; content-visibility: auto; contain-intrinsic-size: 48px; }
  .abe-row.abe-selecting { grid-template-columns: 20px 28px minmax(0,1fr) 160px; }
  .abe-row:hover { background: #f0f5f9; }
  .abe-kind { width: 28px; height: 36px; border: 0; background: transparent; color: #68727d; padding: 0; font-size: 18px; cursor: default; }
  .abe-kind[data-action="expand"] { cursor: pointer; }
  .abe-kind[data-action="expand"]:hover { color: #1769aa; background: #e5eef5; border-radius: 4px; }
  .abe-select-checkbox { width: 16px; height: 16px; margin: 0; }
  .abe-link { min-width: 0; color: #165f9b; text-decoration: none; }
  .abe-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abe-meta { display: block; color: #747d87; font-size: 12px; }
  .abe-favorite { border: 0; background: transparent; color: #8a929b; width: 32px; height: 32px; cursor: pointer; font-size: 20px; }
  .abe-favorite[data-active="true"] { color: #d58a00; }
  .abe-blacklist { border: 0; background: transparent; color: #8a929b; width: 28px; height: 32px; cursor: pointer; font-size: 18px; }
  .abe-blacklist[data-active="true"] { color: #b43d3d; }
  .abe-row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 3px; }
  .abe-refresh-directory { border: 0; background: transparent; color: #7a848d; width: 28px; height: 32px; cursor: pointer; font-size: 18px; }
  .abe-refresh-directory:hover, .abe-refresh-directory:focus-visible { color: #1769aa; background: #e5eef5; border-radius: 4px; }
  .abe-refresh-directory:disabled { color: #b4bcc4; cursor: default; }
  .abe-select-root { border: 0; background: transparent; color: #7a848d; width: 28px; height: 32px; cursor: pointer; font-size: 17px; }
  .abe-select-root:hover, .abe-select-root:focus-visible { color: #1769aa; background: #e5eef5; border-radius: 4px; }
  .abe-select-root:disabled { color: #c3c9ce; cursor: default; }
  .abe-reclassify { border: 0; background: transparent; color: #7a848d; width: 28px; height: 32px; cursor: pointer; font-size: 16px; }
  @media (max-width: 520px) {
    .abe-launcher { left: 12px; bottom: 72px; }
    .abe-panel { width: 100vw; }
    .abe-resize-handle { display: none; }
    .abe-status { display: none; }
    .abe-controls { grid-template-columns: minmax(0, 1fr) 100px; }
    .abe-toolbar { grid-template-columns: auto 1fr auto; }
    .abe-progress { justify-self: end; }
    .abe-auto-scan-fields { grid-template-columns: minmax(0, 1fr) 96px; }
  }
`;
