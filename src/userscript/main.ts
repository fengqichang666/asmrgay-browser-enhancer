import { childrenOf, createGraph, directChildren, graphEntries, hydrateGraph, mergeEntries, reconcileDirectoryChildren, removeNodes, serializeGraph, setNodeType } from "../core/graph.js";
import type { DiscoveredEntry, IndexGraph, NodeType } from "../core/graph.js";
import { createIndexExport, mergeEntryLists, parseIndexExport } from "../core/schema.js";
import { scanAListDirectory, type FailureRecord } from "../scanner/alist.js";
import { TreeScanController, type TreeScanCheckpoint, type TreeScanProgress } from "../scanner/tree.js";
import { deleteIndexState, loadIndexState, saveIndexState } from "../storage/index-store.js";
import { PANEL_STYLES } from "./styles.js";

const FAVORITES_KEY = "asmrgay-enhancer:favorites:v1";
const PANEL_WIDTH_KEY = "asmrgay-enhancer:panel-width:v1";
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const AUTO_SCAN_DEFAULT_INTERVAL_MS = 30_000;
const AUTO_SCAN_MIN_INTERVAL_MS = 500;
const PANEL_WIDTH_DEFAULT = 560;
const PANEL_WIDTH_MIN = 360;
const PANEL_WIDTH_MAX = 1_200;

type AutoScanState = "idle" | "running" | "paused" | "stopped" | "completed";

type VisibleTreeRow =
  | { kind: "entry"; entry: DiscoveredEntry; depth: number; expanded: boolean }
  | { kind: "load-more"; path: string; depth: number; loaded: number; total: number }
  | { kind: "loading"; path: string; depth: number }
  | { kind: "error"; path: string; depth: number; failure: FailureRecord };

class OnDemandPanel {
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly count: HTMLElement;
  private readonly pathLabel: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly typeSelect: HTMLSelectElement;
  private readonly autoScanRootInput: HTMLInputElement;
  private readonly autoScanIntervalInput: HTMLInputElement;
  private readonly autoScanProgress: HTMLElement;
  private readonly player: HTMLElement;
  private readonly playerTitle: HTMLElement;
  private readonly audio: HTMLAudioElement;
  private entries: DiscoveredEntry[] = [];
  private graph: IndexGraph = createGraph();
  private favorites = new Set<string>();
  private blacklisted = new Set<string>();
  private loadedDirectories = new Set<string>();
  private directoryPagination = new Map<string, { nextPage: number; loaded: number; total: number; complete: boolean }>();
  private loadingDirectories = new Set<string>();
  private failures: FailureRecord[] = [];
  private selectedDirectory = currentPath();
  private seenUrls = new Set<string>();
  private directoryErrors = new Map<string, FailureRecord>();
  private filteredEntries: DiscoveredEntry[] = [];
  private directoryLoadedAt = new Map<string, string>();
  private pendingRefreshChildren = new Map<string, Set<string>>();
  private blacklistPending = new Set<string>();
  private selectionMode = false;
  private selectedUrls = new Set<string>();
  private bulkBlacklistPending = false;
  private bulkDeletePending = false;
  private expandedDirectories = new Set<string>();
  private visibleRows: VisibleTreeRow[] = [];
  private audioRequestId = 0;
  private autoScanController: TreeScanController | undefined;
  private autoScanState: AutoScanState = "idle";
  private autoScanCheckpoint: TreeScanCheckpoint | undefined;
  private autoScanRootPath = currentPath();
  private autoScanIntervalMs = AUTO_SCAN_DEFAULT_INTERVAL_MS;
  private autoScanFailureCount = 0;
  private panelWidth = readPanelWidth();

  constructor() {
    const host = document.createElement("div");
    host.id = "asmrgay-browser-enhancer";
    document.documentElement.append(host);
    this.root = host.attachShadow({ mode: "open" });
    this.root.innerHTML = this.template();
    this.panel = this.requireElement(".abe-panel");
    this.setPanelWidth(this.panelWidth, false);
    this.list = this.requireElement(".abe-list");
    this.status = this.requireElement(".abe-status");
    this.count = this.requireElement(".abe-count");
    this.pathLabel = this.requireElement(".abe-path");
    this.searchInput = this.requireElement<HTMLInputElement>(".abe-search");
    this.typeSelect = this.requireElement<HTMLSelectElement>(".abe-type");
    this.autoScanRootInput = this.requireElement<HTMLInputElement>(".abe-scan-root");
    this.autoScanIntervalInput = this.requireElement<HTMLInputElement>(".abe-scan-interval");
    this.autoScanProgress = this.requireElement(".abe-scan-progress");
    this.autoScanRootInput.value = this.autoScanRootPath;
    this.autoScanIntervalInput.value = String(this.autoScanIntervalMs / 1_000);
    this.player = document.createElement("section");
    this.player.className = "abe-player abe-hidden";
    this.player.setAttribute("aria-label", "音频播放器");
    this.player.innerHTML = '<div class="abe-player-top"><strong class="abe-player-title">未选择音频</strong><button class="abe-icon-button abe-player-close" type="button" aria-label="关闭播放器">×</button></div><audio class="abe-audio" controls preload="metadata"></audio>';
    this.panel.append(this.player);
    this.playerTitle = this.requireElement(".abe-player-title");
    this.audio = this.requireElement<HTMLAudioElement>(".abe-audio");
    this.bindEvents();
    this.updatePath();
    void this.restoreState();
  }

  private template(): string {
    return `<style>${PANEL_STYLES}</style>
      <button class="abe-launcher" type="button" title="打开目录索引">索</button>
      <section class="abe-panel abe-hidden" aria-label="ASMRGay 按需目录索引">
        <header class="abe-header"><div class="abe-title"><strong>按需目录索引</strong><span class="abe-path"></span></div><button class="abe-icon-button abe-close" type="button" aria-label="关闭">×</button></header>
        <div class="abe-toolbar"><button class="abe-primary abe-refresh" type="button" title="重新请求当前目录第一页">↻ 刷新</button><span class="abe-status">仅在展开或刷新时请求</span><span class="abe-progress"><span class="abe-count"></span> 项</span><details class="abe-data-menu"><summary>数据</summary><div class="abe-data-actions"><button type="button" class="abe-secondary abe-export">导出索引</button><button type="button" class="abe-secondary abe-export-favorites">收藏 JSON</button><button type="button" class="abe-secondary abe-export-csv">收藏 CSV</button><select class="abe-import-mode" aria-label="导入模式"><option value="merge">合并导入</option><option value="replace">替换导入</option></select><button type="button" class="abe-secondary abe-import">导入索引</button><button type="button" class="abe-secondary abe-failures">失败日志</button><button type="button" class="abe-secondary abe-clear">清空索引</button><input class="abe-file abe-hidden" type="file" accept="application/json,.json"></div></details></div>
        <details class="abe-auto-scan"><summary>自动递归扫描</summary><div class="abe-auto-scan-body"><div class="abe-auto-scan-fields"><label>根目录<input class="abe-scan-root" type="text" inputmode="url" spellcheck="false" aria-label="自动扫描根目录"></label><label>间隔（秒）<input class="abe-scan-interval" type="number" min="0.5" max="3600" step="0.5" aria-label="自动扫描请求间隔"></label></div><div class="abe-auto-scan-actions"><button class="abe-primary abe-scan-start" type="button">开始扫描</button><button class="abe-secondary abe-scan-pause" type="button" disabled>暂停</button><button class="abe-secondary abe-scan-resume" type="button" disabled>继续</button><button class="abe-secondary abe-scan-stop" type="button" disabled>停止</button></div><span class="abe-scan-progress">未开始</span></div></details>
        <div class="abe-controls"><input class="abe-search" type="search" placeholder="搜索已加载目录"><select class="abe-type"><option value="all">全部</option><option value="directory">目录</option><option value="content">文件</option><option value="favorite">收藏</option><option value="seen">已看</option><option value="unseen">未看</option><option value="blacklisted">黑名单</option></select><button type="button" class="abe-secondary abe-multi-select" aria-pressed="false">多选</button><button type="button" class="abe-secondary abe-blacklist-selected abe-hidden" disabled>拉黑选中</button><button type="button" class="abe-secondary abe-delete-selected abe-hidden" disabled>删除缓存</button></div>
        <nav class="abe-breadcrumbs"></nav><div class="abe-list"><div class="abe-empty">展开目录后建立索引</div></div><div class="abe-resize-handle" role="separator" aria-label="拖动调整面板宽度" aria-orientation="vertical" tabindex="0"></div>
      </section>`;
  }

  private bindEvents(): void {
    this.requireElement(".abe-launcher").addEventListener("click", () => { this.panel.classList.remove("abe-hidden"); void this.ensureDirectory(currentPath(), false); });
    this.requireElement(".abe-close").addEventListener("click", () => this.panel.classList.add("abe-hidden"));
    this.requireElement(".abe-refresh").addEventListener("click", () => void this.ensureDirectory(this.selectedDirectory, true));
    this.requireElement(".abe-scan-start").addEventListener("click", () => void this.startAutoScan());
    this.requireElement(".abe-scan-pause").addEventListener("click", () => this.pauseAutoScan());
    this.requireElement(".abe-scan-resume").addEventListener("click", () => this.resumeAutoScan());
    this.requireElement(".abe-scan-stop").addEventListener("click", () => this.stopAutoScan());
    this.bindPanelResize();
    this.searchInput.addEventListener("input", () => { this.clearSelection(); this.render(); });
    this.typeSelect.addEventListener("change", () => { this.clearSelection(); this.render(); });
    this.requireElement(".abe-multi-select").addEventListener("click", () => this.toggleSelectionMode());
    this.requireElement(".abe-blacklist-selected").addEventListener("click", () => void this.blacklistSelectedEntries());
    this.requireElement(".abe-delete-selected").addEventListener("click", () => void this.deleteSelectedEntries());
    this.list.addEventListener("click", (event) => this.handleListClick(event));
    this.list.addEventListener("change", (event) => this.handleSelectionChange(event));
    this.requireElement(".abe-export").addEventListener("click", () => this.exportIndex());
    this.requireElement(".abe-export-favorites").addEventListener("click", () => this.exportFavoritesJson());
    this.requireElement(".abe-export-csv").addEventListener("click", () => this.exportFavoritesCsv());
    this.requireElement(".abe-import").addEventListener("click", () => this.requireElement<HTMLInputElement>(".abe-file").click());
    this.requireElement<HTMLInputElement>(".abe-file").addEventListener("change", (event) => void this.importIndex(event));
    this.requireElement(".abe-failures").addEventListener("click", () => this.exportFailures());
    this.requireElement(".abe-clear").addEventListener("click", () => void this.clearIndex());
    this.requireElement(".abe-player-close").addEventListener("click", () => this.closePlayer());
    this.audio.setAttribute("referrerpolicy", "no-referrer");
    this.audio.addEventListener("error", () => { this.status.textContent = "播放失败：音频地址不可用或暂时无法访问"; });
    window.setInterval(() => this.updatePath(), 500);
  }

  private bindPanelResize(): void {
    const handle = this.requireElement<HTMLElement>(".abe-resize-handle");
    let startX = 0;
    let startWidth = this.panelWidth;
    let resizing = false;
    const stop = (): void => {
      if (!resizing) return;
      resizing = false;
      handle.classList.remove("abe-resizing");
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(this.panelWidth)); } catch { /* Storage is optional. */ }
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizing = true;
      startX = event.clientX;
      startWidth = this.panelWidth;
      handle.classList.add("abe-resizing");
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!resizing) return;
      this.setPanelWidth(startWidth + event.clientX - startX, false);
    });
    handle.addEventListener("pointerup", (event) => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      stop();
    });
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 80 : 20;
      if (event.key === "ArrowRight") { event.preventDefault(); this.setPanelWidth(this.panelWidth + step); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); this.setPanelWidth(this.panelWidth - step); }
      else return;
      handle.focus();
    });
    window.addEventListener("resize", () => this.setPanelWidth(this.panelWidth, false));
  }

  private setPanelWidth(width: number, persist = true): void {
    this.panelWidth = clampPanelWidth(width);
    this.panel.style.setProperty("--abe-panel-width", `${this.panelWidth}px`);
    const handle = this.root.querySelector<HTMLElement>(".abe-resize-handle");
    handle?.setAttribute("aria-valuenow", String(this.panelWidth));
    handle?.setAttribute("aria-valuemin", String(PANEL_WIDTH_MIN));
    handle?.setAttribute("aria-valuemax", String(panelWidthMax()));
    if (persist) {
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(this.panelWidth)); } catch { /* Storage is optional. */ }
    }
  }

  private async ensureDirectory(path: string, force: boolean): Promise<void> {
    const normalized = normalizePath(path);
    if (this.loadingDirectories.has(normalized)) return;
    const pagination = this.directoryPagination.get(normalized);
    if (!force && pagination?.complete) { this.status.textContent = "已使用缓存；点击刷新当前目录可重新请求"; this.render(); return; }
    const startPage = force ? 1 : pagination?.nextPage ?? 1;
    if (force && startPage === 1) {
      this.pendingRefreshChildren.set(normalized, directChildren(this.graph, new URL(encodePath(normalized), location.origin).href));
    }
    this.loadingDirectories.add(normalized);
    this.status.textContent = force ? "正在刷新当前目录…" : "正在读取当前目录…";
    this.setRefreshDisabled(true);
    try {
      const result = await scanAListDirectory(normalized, { pageSize: 100, startPage, maxPages: 1, maxRetries: 0, delayMs: 0, jitterMs: 0, onFailure: (failure) => this.failures.push(failure) });
      const scopedEntries = result.entries.map((entry) => ({ ...entry, metadata: { ...entry.metadata, parentPath: normalized } }));
      mergeEntries(this.graph, new URL(encodePath(normalized), location.origin).href, scopedEntries, new Date().toISOString(), force || startPage === 1);
      this.entries = graphEntries(this.graph);
      this.loadedDirectories.add(normalized);
      const previousLoaded = force ? 0 : pagination?.loaded ?? 0;
      this.directoryPagination.set(normalized, { nextPage: startPage + result.pagesLoaded, loaded: previousLoaded + result.entries.length, total: result.total, complete: previousLoaded + result.entries.length >= result.total || result.entries.length === 0 });
      this.directoryLoadedAt.set(normalized, new Date().toISOString());
      this.directoryErrors.delete(normalized);
      const state = this.directoryPagination.get(normalized)!;
      if (state.complete) {
        const parentId = new URL(encodePath(normalized), location.origin).href;
        reconcileDirectoryChildren(this.graph, this.pendingRefreshChildren.get(normalized) ?? new Set(), directChildren(this.graph, parentId));
        this.pendingRefreshChildren.delete(normalized);
        this.entries = graphEntries(this.graph);
      }
      this.failures.push(...result.failures);
      await this.persistState(normalized);
      this.status.textContent = state.complete ? `目录已加载完，共 ${state.loaded} 项` : `已加载 ${state.loaded} / ${state.total} 项；可点击“加载更多”`;
    } catch (error) { const failure: FailureRecord = { path: normalized, kind: /1015|rate limited/i.test(error instanceof Error ? error.message : "") ? "429" : "network", message: error instanceof Error ? error.message : "读取目录失败", attempts: 1, occurredAt: new Date().toISOString() }; this.directoryErrors.set(normalized, failure); this.failures.push(failure); this.status.textContent = failure.message; }
    finally {
      this.loadingDirectories.delete(normalized);
      this.setRefreshDisabled(false);
      this.render();
    }
  }

  private async startAutoScan(): Promise<void> {
    if (this.autoScanState === "running" || this.autoScanState === "paused") return;
    const rootPath = normalizePath(this.autoScanRootInput.value.trim() || this.selectedDirectory || currentPath());
    const intervalMs = readScanInterval(this.autoScanIntervalInput.value);
    if (intervalMs === undefined) {
      this.status.textContent = "自动扫描间隔必须是 0.5 到 3600 秒";
      return;
    }
    if (!window.confirm(`确定从 ${rootPath} 开始自动递归扫描吗？扫描会按 ${formatSeconds(intervalMs)} 秒间隔请求目录并写入缓存。`)) return;
    this.autoScanRootPath = rootPath;
    this.autoScanIntervalMs = intervalMs;
    this.autoScanRootInput.value = rootPath;
    this.autoScanCheckpoint = undefined;
    this.autoScanState = "running";
    this.autoScanFailureCount = 0;
    void this.runAutoScan(rootPath, intervalMs);
  }

  private pauseAutoScan(): void {
    if (!this.autoScanController || this.autoScanState !== "running") return;
    this.autoScanController.pause();
    this.autoScanState = "paused";
    this.status.textContent = "自动扫描将在当前目录完成后暂停";
    this.updateAutoScanControls();
  }

  private resumeAutoScan(): void {
    if (this.autoScanController && this.autoScanState === "paused") {
      this.autoScanState = "running";
      this.autoScanController.resume();
      this.status.textContent = "自动扫描继续中…";
      this.updateAutoScanControls();
      return;
    }
    if (this.autoScanState === "running") return;
    if (!this.autoScanCheckpoint) {
      const recovered = this.createRecoveredCheckpoint();
      if (!recovered) {
        this.status.textContent = "没有可恢复的自动扫描队列";
        this.updateAutoScanControls();
        return;
      }
      this.autoScanCheckpoint = recovered;
      this.autoScanRootPath = recovered.rootPath;
    }
    const intervalMs = readScanInterval(this.autoScanIntervalInput.value) ?? this.autoScanIntervalMs;
    this.autoScanIntervalMs = intervalMs;
    this.autoScanState = "running";
    void this.runAutoScan(this.autoScanRootPath, intervalMs, this.autoScanCheckpoint);
  }

  private stopAutoScan(): void {
    if (!this.autoScanController || (this.autoScanState !== "running" && this.autoScanState !== "paused")) return;
    this.autoScanState = "stopped";
    this.autoScanController.stop();
    this.status.textContent = "正在停止自动扫描并保存断点…";
    this.updateAutoScanControls();
  }

  private async runAutoScan(rootPath: string, intervalMs: number, resumeFrom?: TreeScanCheckpoint): Promise<void> {
    if (this.autoScanController) return;
    const controller = new TreeScanController();
    this.autoScanController = controller;
    this.autoScanFailureCount = resumeFrom?.failures.length ?? 0;
    this.autoScanProgress.textContent = resumeFrom ? "准备从断点继续…" : "准备开始…";
    this.updateAutoScanControls();
    try {
      await this.persistState(rootPath);
      const result = await controller.run(rootPath, {
        maxDepth: 10,
        maxNodes: 50_000,
        maxDirectories: 2_000,
        directoryDelayMs: intervalMs,
        directoryJitterMs: Math.min(500, intervalMs),
        directoryOptions: {
          pageSize: 100,
          maxPages: 200,
          maxRetries: 3,
          delayMs: intervalMs,
          jitterMs: Math.min(500, intervalMs),
        },
        ...(resumeFrom ? { resumeFrom } : {}),
        scanDirectory: async (path, options) => {
          const result = await scanAListDirectory(path, options);
          const normalized = normalizePath(path);
          const parentUrl = new URL(encodePath(normalized), location.origin).href;
          const now = new Date().toISOString();
          const scanRootPath = normalizePath(rootPath);
          const previousChildren = directChildren(this.graph, parentUrl);
          const scopedEntries = result.entries.map((entry) => ({
            ...entry,
            metadata: {
              ...entry.metadata,
              depth: pathDepth(scanRootPath, normalized),
              parentPath: normalized,
              scanRootPath,
            },
          }));
          mergeEntries(this.graph, parentUrl, scopedEntries, now, true);
          reconcileDirectoryChildren(this.graph, previousChildren, directChildren(this.graph, parentUrl), now);
          this.entries = graphEntries(this.graph);
          this.loadedDirectories.add(normalized);
          this.directoryPagination.set(normalized, {
            nextPage: result.startPage + result.pagesLoaded,
            loaded: result.entries.length,
            total: result.total,
            complete: !result.truncated,
          });
          this.directoryLoadedAt.set(normalized, now);
          this.directoryErrors.delete(normalized);
          this.render();
          return result;
        },
        onProgress: (progress) => this.updateAutoScanProgress(progress),
        onCheckpoint: async (checkpoint) => {
          this.autoScanCheckpoint = checkpoint;
          this.absorbAutoScanFailures(checkpoint.failures);
          await this.persistState(rootPath);
        },
      });
      this.autoScanCheckpoint = result.checkpoint;
      this.absorbAutoScanFailures(result.failures);
      this.autoScanState = result.stopped || result.checkpoint ? "stopped" : "completed";
      await this.persistState(rootPath);
      this.status.textContent = result.stopped
        ? `自动扫描已停止，已扫描 ${result.directoriesScanned} 个目录`
        : result.checkpoint
          ? `自动扫描已到达安全上限，可继续剩余 ${result.checkpoint.frontier.length} 个目录`
          : `自动扫描完成，已扫描 ${result.directoriesScanned} 个目录`;
    } catch (error) {
      this.autoScanState = "stopped";
      this.status.textContent = error instanceof Error ? `自动扫描失败：${error.message}` : "自动扫描失败";
      await this.persistState(rootPath);
    } finally {
      if (this.autoScanController === controller) this.autoScanController = undefined;
      this.updateAutoScanControls();
      this.render();
    }
  }

  private absorbAutoScanFailures(failures: readonly FailureRecord[]): void {
    if (this.autoScanFailureCount > failures.length) this.autoScanFailureCount = 0;
    this.failures.push(...failures.slice(this.autoScanFailureCount));
    this.autoScanFailureCount = failures.length;
  }

  private updateAutoScanProgress(progress: TreeScanProgress): void {
    const state = progress.state === "paused" ? "已暂停" : progress.state === "stopped" ? "已停止" : progress.state === "completed" ? "已完成" : "扫描中";
    this.autoScanProgress.textContent = `${state} · 当前 ${progress.currentPath || "-"} · 目录 ${progress.directoriesScanned} · 队列 ${progress.directoriesQueued} · 条目 ${progress.entriesDiscovered}`;
    if (progress.state === "running") this.status.textContent = `自动扫描中：${progress.currentPath || "准备下一目录"}`;
    else if (progress.state === "paused") {
      this.autoScanState = "paused";
      this.status.textContent = `自动扫描已暂停，点击“继续”重试：${progress.currentPath || "当前目录"}`;
      this.updateAutoScanControls();
    }
  }

  private updateAutoScanControls(): void {
    const active = this.autoScanState === "running" || this.autoScanState === "paused";
    const running = this.autoScanState === "running";
    const start = this.requireElement<HTMLButtonElement>(".abe-scan-start");
    const pause = this.requireElement<HTMLButtonElement>(".abe-scan-pause");
    const resume = this.requireElement<HTMLButtonElement>(".abe-scan-resume");
    const stop = this.requireElement<HTMLButtonElement>(".abe-scan-stop");
    start.disabled = active;
    pause.disabled = !running;
    const canRecover = !this.autoScanController && !this.autoScanCheckpoint && this.hasRecoverableScan();
    resume.disabled = running || (!this.autoScanCheckpoint && !canRecover && !this.autoScanController);
    resume.textContent = this.autoScanCheckpoint ? "继续" : "恢复扫描";
    stop.disabled = !active;
  }

  private hasRecoverableScan(): boolean {
    const rootPath = normalizePath(this.autoScanRootPath);
    const loadedPaths = [...this.loadedDirectories]
      .map(normalizePath)
      .filter((path) => isPathWithin(rootPath, path));
    if (loadedPaths.some((path) => this.directoryPagination.get(path)?.complete === false)) return true;
    const loaded = new Set(loadedPaths);
    const hasUnloadedChild = loadedPaths.some((parentPath) => childrenOf(this.graph, urlForPath(parentPath)).some((node) => {
      const childPath = pathFromUrl(node.url);
      return node.type === "directory" && !loaded.has(childPath) && scanDepth(rootPath, childPath) < 10;
    }));
    const hasScopedNodes = [...this.graph.nodes.values()]
      .some((node) => node.url !== urlForPath(rootPath) && isPathWithin(rootPath, pathFromUrl(node.url)));
    return hasUnloadedChild || (!loaded.has(rootPath) && hasScopedNodes);
  }

  // Rebuild only the missing BFS frontier; cached entries remain in the graph.
  private createRecoveredCheckpoint(): TreeScanCheckpoint | undefined {
    const rootPath = normalizePath(this.autoScanRootPath);
    const rootUrl = urlForPath(rootPath);
    const loadedPaths = new Set([...this.loadedDirectories]
      .map(normalizePath)
      .filter((path) => isPathWithin(rootPath, path)));
    const incompletePaths = new Set([...loadedPaths]
      .filter((path) => this.directoryPagination.get(path)?.complete === false));
    const visitedDirectories = new Set([...loadedPaths].filter((path) => !incompletePaths.has(path)));
    const frontier = [...this.graph.nodes.values()]
      .filter((node) => node.type === "directory")
      .map((node) => ({ path: pathFromUrl(node.url), depth: scanDepth(rootPath, pathFromUrl(node.url)) }))
      .filter((entry) => entry.depth < 10 && isPathWithin(rootPath, entry.path) && !visitedDirectories.has(entry.path))
      .filter((entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path) === index)
      .sort((left, right) => left.depth - right.depth);
    const hasScopedNodes = [...this.graph.nodes.values()]
      .some((node) => node.url !== rootUrl && isPathWithin(rootPath, pathFromUrl(node.url)));
    if (!loadedPaths.has(rootPath) && hasScopedNodes && !frontier.some((entry) => entry.path === rootPath)) frontier.unshift({ path: rootPath, depth: 0 });
    if (frontier.length === 0) return undefined;
    const entries = [...this.graph.nodes.values()]
      .filter((node) => node.url !== rootUrl && isPathWithin(rootPath, pathFromUrl(node.url)))
      .map(nodeToEntry);
    const failures = this.failures.filter((failure) => isPathWithin(rootPath, failure.path));
    return {
      rootPath,
      maxDepth: 10,
      maxNodes: 50_000,
      maxDirectories: 2_000,
      frontier,
      visitedDirectories: [...visitedDirectories],
      entries,
      failures,
      directoriesScanned: visitedDirectories.size,
      updatedAt: new Date().toISOString(),
    };
  }

  private handleListClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;
    if (action === "expand" && path) {
      this.toggleDirectory(path);
      return;
    }
    if (action === "select-root" && path) {
      const normalized = normalizePath(path);
      this.autoScanRootPath = normalized;
      this.autoScanRootInput.value = normalized;
      const autoScan = this.requireElement<HTMLDetailsElement>(".abe-auto-scan");
      autoScan.open = true;
      this.status.textContent = `已选择扫描根目录：${normalized}`;
      return;
    }
    if (action === "refresh" && path) {
      const button = target.closest<HTMLButtonElement>("[data-action=\"refresh\"]");
      if (button) button.disabled = true;
      void this.ensureDirectory(path, true);
      return;
    }
    if (action === "load-more" && path) { void this.ensureDirectory(path, false); return; }
    if (action === "retry" && path) { void this.ensureDirectory(path, false); return; }
    const reclassify = target.closest<HTMLButtonElement>(".abe-reclassify");
    const reclassifyUrl = reclassify?.dataset.url;
    if (reclassify && reclassifyUrl) {
      const node = this.graph.nodes.get(reclassifyUrl);
      if (node) {
        const nextType = node.type === "directory" ? "content" : "directory";
        setNodeType(this.graph, reclassifyUrl, nextType);
        this.entries = graphEntries(this.graph);
        void this.persistState(this.selectedDirectory);
        this.render();
      }
      return;
    }
    const blacklist = target.closest<HTMLButtonElement>(".abe-blacklist");
    const blacklistUrl = blacklist?.dataset.url;
    if (blacklist && blacklistUrl) {
      const entry = this.entries.find((item) => item.url === blacklistUrl);
      if (entry && !this.blacklistPending.has(entry.url)) {
        blacklist.disabled = true;
        void this.toggleBlacklist(entry);
      }
      return;
    }
    const button = target.closest<HTMLButtonElement>(".abe-favorite");
    const url = button?.dataset.url;
    if (!button || !url) return;
    if (this.favorites.has(url)) this.favorites.delete(url); else this.favorites.add(url);
    void this.persistState(currentPath()); this.render();
  }

  private handleSelectionChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches("[data-select]")) return;
    const url = target.dataset.select;
    if (!url || target.disabled) return;
    if (target.checked) this.selectedUrls.add(url); else this.selectedUrls.delete(url);
    this.updateSelectionControls();
  }

  private toggleSelectionMode(): void {
    this.selectionMode = !this.selectionMode;
    if (!this.selectionMode) this.clearSelection();
    this.render();
  }

  private clearSelection(): void { this.selectedUrls.clear(); }

  private updateSelectionControls(): void {
    for (const url of this.selectedUrls) if (!this.entries.some((entry) => entry.url === url) || this.blacklisted.has(url)) this.selectedUrls.delete(url);
    const selectedCount = this.selectedUrls.size;
    const multiSelect = this.requireElement<HTMLButtonElement>(".abe-multi-select");
    const blacklistSelected = this.requireElement<HTMLButtonElement>(".abe-blacklist-selected");
    const deleteSelected = this.requireElement<HTMLButtonElement>(".abe-delete-selected");
    multiSelect.textContent = this.selectionMode ? "退出多选" : "多选";
    multiSelect.setAttribute("aria-pressed", String(this.selectionMode));
    blacklistSelected.classList.toggle("abe-hidden", !this.selectionMode);
    blacklistSelected.disabled = this.bulkBlacklistPending || selectedCount === 0;
    blacklistSelected.textContent = selectedCount ? `拉黑选中 (${selectedCount})` : "拉黑选中";
    deleteSelected.classList.toggle("abe-hidden", !this.selectionMode);
    deleteSelected.disabled = this.bulkDeletePending || selectedCount === 0;
    deleteSelected.textContent = selectedCount ? `删除缓存 (${selectedCount})` : "删除缓存";
  }

  private toggleDirectory(path: string): void {
    const normalized = normalizePath(path);
    if (this.expandedDirectories.has(normalized)) {
      this.expandedDirectories.delete(normalized);
    } else {
      this.expandedDirectories.add(normalized);
      const parentUrl = new URL(encodePath(normalized), location.origin).href;
      const page = this.directoryPagination.get(normalized);
      const cacheLooksIncomplete = this.loadedDirectories.has(normalized) && (page?.loaded ?? 0) > 0 && childrenOf(this.graph, parentUrl).length === 0;
      if (!this.loadedDirectories.has(normalized)) void this.ensureDirectory(normalized, false);
      else if (cacheLooksIncomplete) void this.ensureDirectory(normalized, true);
    }
    void this.persistState(normalized);
    this.render();
  }

  private render(): void {
    this.updateSelectionControls();
    const query = this.searchInput.value.trim().toLocaleLowerCase();
    const type = this.typeSelect.value;
    const scopedEntries = query || type === "favorite" || type === "seen" || type === "unseen" || type === "blacklisted"
      ? this.entries
      : childrenOf(this.graph, new URL(encodePath(this.selectedDirectory), location.origin).href).map(nodeToEntry);
    const filtered = scopedEntries.filter((entry) => {
      const inBlacklist = this.blacklisted.has(entry.url);
      const matchesType = type === "blacklisted" ? inBlacklist : inBlacklist ? false : type === "favorite" ? this.favorites.has(entry.url) : type === "seen" ? this.seenUrls.has(entry.url) : type === "unseen" ? !this.seenUrls.has(entry.url) : type === "all" || entry.type === type;
      return matchesType && (!query || `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query));
    });
    this.filteredEntries = filtered;
    this.visibleRows = query || type !== "all" ? filtered.map((entry) => ({ kind: "entry", entry, depth: 0, expanded: false })) : this.flattenTree();
    this.renderBreadcrumbs();
    this.count.textContent = String(this.visibleRows.filter((row) => row.kind === "entry").length);
    this.renderWindow();
  }

  private flattenTree(): VisibleTreeRow[] {
    const rows: VisibleTreeRow[] = [];
    const rootUrl = new URL(encodePath(this.selectedDirectory), location.origin).href;
    const visit = (parentUrl: string, depth: number, ancestors: ReadonlySet<string>): void => {
      for (const node of childrenOf(this.graph, parentUrl)) {
        if (ancestors.has(node.url)) continue;
        if (this.blacklisted.has(node.url)) continue;
        const entry = nodeToEntry(node);
        const path = pathFromUrl(entry.url);
        const expanded = entry.type === "directory" && this.expandedDirectories.has(path);
        rows.push({ kind: "entry", entry, depth, expanded });
        if (entry.type !== "directory" || !expanded) continue;
        const error = this.directoryErrors.get(path);
        if (error) { rows.push({ kind: "error", path, depth: depth + 1, failure: error }); continue; }
        if (this.loadingDirectories.has(path)) { rows.push({ kind: "loading", path, depth: depth + 1 }); continue; }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(node.url);
        visit(node.url, depth + 1, nextAncestors);
        const page = this.directoryPagination.get(path);
        if (page && !page.complete) rows.push({ kind: "load-more", path, depth: depth + 1, loaded: page.loaded, total: page.total });
      }
    };
    visit(rootUrl, 0, new Set([rootUrl]));
    return rows;
  }

  private renderWindow(): void {
    const scrollTop = this.list.scrollTop;
    this.list.replaceChildren();
    if (!this.visibleRows.length) { const empty = document.createElement("div"); empty.className = "abe-empty"; empty.textContent = typeEmptyMessage(this.typeSelect.value, this.entries.length > 0); this.list.append(empty); this.list.scrollTop = scrollTop; return; }
    const fragment = document.createDocumentFragment();
    for (const row of this.visibleRows) fragment.append(this.createTreeRow(row));
    this.list.append(fragment);
    this.list.scrollTop = scrollTop;
  }

  private renderBreadcrumbs(): void {
    const container = this.requireElement(".abe-breadcrumbs"); container.replaceChildren();
    const root = document.createElement("button"); root.type = "button"; root.textContent = "/"; root.addEventListener("click", () => { this.selectedDirectory = "/"; this.autoScanRootInput.value = "/"; void this.ensureDirectory("/", false); }); container.append(root);
    let path = ""; for (const segment of this.selectedDirectory.split("/").filter(Boolean)) { path += `/${segment}`; const separator = document.createElement("span"); separator.textContent = " / "; const button = document.createElement("button"); button.type = "button"; button.textContent = safeDecode(segment); const target = path; button.addEventListener("click", () => { this.selectedDirectory = target; this.autoScanRootInput.value = target; void this.ensureDirectory(target, false); }); container.append(separator, button); }
  }

  private createTreeRow(row: VisibleTreeRow): HTMLElement {
    if (row.kind === "load-more") {
      const button = document.createElement("button"); button.type = "button"; button.className = "abe-load-more"; button.dataset.action = "load-more"; button.dataset.path = row.path; button.style.paddingLeft = `${14 + row.depth * 22}px`; button.textContent = `↳ 加载更多（${row.loaded} / ${row.total}）`; return button;
    }
    if (row.kind === "loading") {
      const element = document.createElement("div"); element.className = "abe-tree-loading"; element.style.paddingLeft = `${14 + row.depth * 22}px`; element.textContent = "正在读取…"; return element;
    }
    if (row.kind === "error") {
      const button = document.createElement("button"); button.type = "button"; button.className = "abe-tree-error"; button.dataset.action = "retry"; button.dataset.path = row.path; button.style.paddingLeft = `${14 + row.depth * 22}px`; button.textContent = `⚠ ${row.failure.message} · 点击重试`; return button;
    }
    const entry = row.entry;
    const element = document.createElement("div"); element.className = "abe-row";
    element.style.paddingLeft = `${14 + row.depth * 22}px`;
    if (this.selectionMode) {
      element.classList.add("abe-selecting");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "abe-select-checkbox";
      checkbox.dataset.select = entry.url;
      checkbox.checked = this.selectedUrls.has(entry.url);
      checkbox.disabled = this.blacklisted.has(entry.url) || this.bulkBlacklistPending;
      checkbox.setAttribute("aria-label", `选择 ${entry.title}`);
      element.append(checkbox);
    }
    const kind = document.createElement("button"); kind.type = "button"; kind.className = "abe-kind"; kind.dataset.action = entry.type === "directory" ? "expand" : "noop"; kind.dataset.path = entry.type === "directory" ? pathFromUrl(entry.url) : ""; kind.textContent = entry.type === "directory" ? (row.expanded ? "▾" : "▸") : "♪"; kind.title = entry.type === "directory" ? (row.expanded ? "收起目录" : "展开目录") : "文件";
    const link = document.createElement("a"); link.className = "abe-link"; link.href = entry.url;
    if (entry.type === "directory") { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    const name = document.createElement("span"); name.className = "abe-name"; name.textContent = entry.title;
    const meta = document.createElement("span"); meta.className = "abe-meta"; meta.textContent = entry.type === "directory" ? (this.loadedDirectories.has(pathFromUrl(entry.url)) ? `目录 · 已加载${this.directoryLoadedAt.get(pathFromUrl(entry.url)) ? ` · ${formatTime(this.directoryLoadedAt.get(pathFromUrl(entry.url))!)}` : ""}` : "目录 · 点击展开") : formatSize(Number(entry.metadata?.size)) || "文件"; if (entry.metadata?.status === "missing") meta.textContent += " · 已失效"; if (this.seenUrls.has(entry.url)) meta.textContent += " · 已看"; link.append(name, meta); link.addEventListener("click", (event) => { if (entry.type === "directory" && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); this.toggleDirectory(pathFromUrl(entry.url)); return; } if (entry.type === "content") { event.preventDefault(); this.seenUrls.add(entry.url); void this.persistState(this.selectedDirectory); void this.playAudio(entry.url, entry.title); return; } this.seenUrls.add(entry.url); void this.persistState(this.selectedDirectory); });
    const actions = document.createElement("span"); actions.className = "abe-row-actions";
    const favorite = document.createElement("button"); favorite.type = "button"; favorite.className = "abe-favorite"; favorite.dataset.url = entry.url; favorite.dataset.active = String(this.favorites.has(entry.url)); favorite.title = this.favorites.has(entry.url) ? "取消收藏" : "收藏"; favorite.textContent = "★";
    const blacklisted = this.blacklisted.has(entry.url);
    const blacklist = document.createElement("button"); blacklist.type = "button"; blacklist.className = "abe-blacklist"; blacklist.dataset.url = entry.url; blacklist.dataset.active = String(blacklisted); blacklist.title = blacklisted ? "移出黑名单" : "加入黑名单"; blacklist.setAttribute("aria-label", blacklist.title); blacklist.textContent = blacklisted ? "↩" : "⊘";
    blacklist.disabled = this.bulkBlacklistPending || this.blacklistPending.has(entry.url);
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "abe-refresh-directory";
    refresh.dataset.action = "refresh";
    refresh.dataset.path = entry.type === "directory" ? pathFromUrl(entry.url) : "";
    refresh.title = "刷新目录";
    refresh.setAttribute("aria-label", "刷新目录");
    refresh.textContent = "↻";
    refresh.disabled = entry.type !== "directory" || this.loadingDirectories.has(pathFromUrl(entry.url));
    const selectRoot = document.createElement("button");
    selectRoot.type = "button";
    selectRoot.className = "abe-select-root";
    selectRoot.dataset.action = "select-root";
    selectRoot.dataset.path = entry.type === "directory" ? pathFromUrl(entry.url) : "";
    selectRoot.title = "设为自动扫描根目录";
    selectRoot.setAttribute("aria-label", "设为自动扫描根目录");
    selectRoot.textContent = "⌂";
    selectRoot.disabled = entry.type !== "directory";
    const reclassify = document.createElement("button"); reclassify.type = "button"; reclassify.className = "abe-reclassify"; reclassify.dataset.url = entry.url; reclassify.title = "切换目录/文件分类"; reclassify.textContent = "↔";
    actions.append(favorite, blacklist, ...(entry.type === "directory" ? [refresh, selectRoot] : []), reclassify); element.append(kind, link, actions); return element;
  }

  private async toggleBlacklist(entry: DiscoveredEntry): Promise<void> {
    if (this.bulkBlacklistPending) return;
    if (this.blacklistPending.has(entry.url)) return;
    this.blacklistPending.add(entry.url);
    this.selectedUrls.delete(entry.url);
    const active = this.blacklisted.has(entry.url);
    try {
      if (active) this.blacklisted.delete(entry.url);
      else this.blacklisted.add(entry.url);
      try {
        await this.persistState(this.selectedDirectory);
      } catch (error) {
        this.status.textContent = error instanceof Error ? `黑名单保存失败：${error.message}` : "黑名单保存失败";
      }
    } finally {
      this.blacklistPending.delete(entry.url);
      this.render();
    }
  }

  private async blacklistSelectedEntries(): Promise<void> {
    if (this.bulkBlacklistPending) return;
    const urls = [...this.selectedUrls].filter((url) => this.entries.some((entry) => entry.url === url) && !this.blacklisted.has(url));
    if (!urls.length || !window.confirm(`确定将选中的 ${urls.length} 项加入黑名单吗？`)) return;
    const previous = this.blacklisted;
    const previousSelection = new Set(this.selectedUrls);
    this.bulkBlacklistPending = true;
    this.blacklisted = new Set([...previous, ...urls]);
    this.updateSelectionControls();
    this.render();
    try {
      await this.persistState(this.selectedDirectory);
      this.selectedUrls.clear();
      this.status.textContent = `已拉黑 ${urls.length} 项`;
    } catch (error) {
      this.blacklisted = previous;
      this.selectedUrls = previousSelection;
      this.status.textContent = error instanceof Error ? `黑名单保存失败：${error.message}` : "黑名单保存失败";
    } finally {
      this.bulkBlacklistPending = false;
      this.render();
    }
  }

  private async deleteSelectedEntries(): Promise<void> {
    if (this.bulkDeletePending) return;
    if (this.autoScanController || this.autoScanState === "running" || this.autoScanState === "paused") {
      this.status.textContent = "请先暂停或停止自动扫描，再删除缓存";
      return;
    }
    const urls = [...this.selectedUrls].filter((url) => this.entries.some((entry) => entry.url === url));
    if (!urls.length || !window.confirm(`确定删除选中的 ${urls.length} 项缓存吗？目录会连同已缓存的子项一起删除，不会删除远端文件。`)) return;
    const previous = {
      graph: serializeGraph(this.graph),
      entries: this.entries,
      loadedDirectories: new Set(this.loadedDirectories),
      directoryPagination: new Map(this.directoryPagination),
      directoryLoadedAt: new Map(this.directoryLoadedAt),
      directoryErrors: new Map(this.directoryErrors),
      expandedDirectories: new Set(this.expandedDirectories),
      favorites: new Set(this.favorites),
      blacklisted: new Set(this.blacklisted),
      seenUrls: new Set(this.seenUrls),
      selectedUrls: new Set(this.selectedUrls),
      autoScanCheckpoint: this.autoScanCheckpoint,
      autoScanState: this.autoScanState,
    };
    this.bulkDeletePending = true;
    const removed = removeNodes(this.graph, new Set(urls));
    const removedUrls = new Set(removed);
    this.entries = graphEntries(this.graph);
    for (const path of [...this.loadedDirectories]) if (removedUrls.has(urlForPath(path))) this.loadedDirectories.delete(path);
    for (const path of [...this.directoryPagination.keys()]) if (removedUrls.has(urlForPath(path))) this.directoryPagination.delete(path);
    for (const path of [...this.directoryLoadedAt.keys()]) if (removedUrls.has(urlForPath(path))) this.directoryLoadedAt.delete(path);
    for (const path of [...this.directoryErrors.keys()]) if (removedUrls.has(urlForPath(path))) this.directoryErrors.delete(path);
    this.expandedDirectories = new Set([...this.expandedDirectories].filter((path) => !removedUrls.has(urlForPath(path))));
    this.favorites = new Set([...this.favorites].filter((url) => !removedUrls.has(url)));
    this.blacklisted = new Set([...this.blacklisted].filter((url) => !removedUrls.has(url)));
    this.seenUrls = new Set([...this.seenUrls].filter((url) => !removedUrls.has(url)));
    this.selectedUrls.clear();
    this.autoScanCheckpoint = this.pruneAutoScanCheckpoint(removedUrls);
    this.autoScanState = this.autoScanCheckpoint ? "stopped" : "idle";
    this.updateCachedProgress();
    this.render();
    try {
      await this.persistState(this.selectedDirectory);
      this.status.textContent = `已删除 ${removed.size} 项缓存`;
    } catch (error) {
      this.graph = hydrateGraph(previous.graph);
      this.entries = previous.entries;
      this.loadedDirectories = previous.loadedDirectories;
      this.directoryPagination = previous.directoryPagination;
      this.directoryLoadedAt = previous.directoryLoadedAt;
      this.directoryErrors = previous.directoryErrors;
      this.expandedDirectories = previous.expandedDirectories;
      this.favorites = previous.favorites;
      this.blacklisted = previous.blacklisted;
      this.seenUrls = previous.seenUrls;
      this.selectedUrls = previous.selectedUrls;
      this.autoScanCheckpoint = previous.autoScanCheckpoint;
      this.autoScanState = previous.autoScanState;
      this.updateCachedProgress();
      this.status.textContent = error instanceof Error ? `缓存删除保存失败：${error.message}` : "缓存删除保存失败";
    } finally {
      this.bulkDeletePending = false;
      this.render();
    }
  }

  private pruneAutoScanCheckpoint(removedUrls: ReadonlySet<string>): TreeScanCheckpoint | undefined {
    if (!this.autoScanCheckpoint) return undefined;
    const checkpoint = this.autoScanCheckpoint;
    return {
      ...checkpoint,
      frontier: checkpoint.frontier.filter((entry) => !removedUrls.has(urlForPath(entry.path))),
      visitedDirectories: checkpoint.visitedDirectories.filter((path) => !removedUrls.has(urlForPath(path))),
      entries: checkpoint.entries.filter((entry) => !removedUrls.has(entry.url)),
      failures: checkpoint.failures.filter((failure) => !removedUrls.has(urlForPath(failure.path))),
      directoriesScanned: checkpoint.visitedDirectories.filter((path) => !removedUrls.has(urlForPath(path))).length,
      updatedAt: new Date().toISOString(),
    };
  }

  private async playAudio(url: string, title: string): Promise<void> {
    const requestId = ++this.audioRequestId;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.playerTitle.textContent = title;
    this.player.classList.remove("abe-hidden");
    this.status.textContent = "正在获取播放地址…";
    try {
      const mediaUrl = await resolveMediaUrl(url, location.origin);
      if (requestId !== this.audioRequestId) return;
      this.audio.src = mediaUrl;
      this.audio.load();
      this.status.textContent = "播放地址已就绪";
      void this.audio.play().catch(() => { this.status.textContent = "播放地址已就绪，请点击播放器播放"; });
    } catch (error) {
      if (requestId !== this.audioRequestId) return;
      this.status.textContent = error instanceof Error ? `播放地址获取失败：${error.message}` : "播放地址获取失败";
    }
  }

  private updateCachedProgress(): void {
    const rootUrl = new URL(encodePath("/"), location.origin).href;
    const directories = [...this.graph.nodes.values()].filter((node) => node.type === "directory" && node.url !== rootUrl).length;
    const entries = [...this.graph.nodes.values()].filter((node) => node.url !== rootUrl).length;
    const queued = this.autoScanCheckpoint?.frontier.length ?? 0;
    this.autoScanProgress.textContent = `已缓存 · 目录 ${directories} · 队列 ${queued} · 条目 ${entries}`;
  }

  private closePlayer(): void {
    this.audioRequestId += 1;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.player.classList.add("abe-hidden");
  }

  private async restoreState(): Promise<void> {
    try {
      const state = await loadIndexState(location.origin);
      if (state) {
        this.graph = state.graph ? hydrateGraph(state.graph) : createGraph();
        this.entries = state.graph ? graphEntries(this.graph) : state.entries;
        this.favorites = new Set(state.favorites);
        this.blacklisted = new Set(state.blacklisted ?? []);
        this.loadedDirectories = new Set(state.loadedDirectories ?? []);
        this.directoryPagination = new Map(Object.entries(state.directoryPagination ?? {}));
        this.directoryLoadedAt = new Map(Object.entries(state.directoryLoadedAt ?? {}));
        this.failures = state.failures ?? [];
        this.seenUrls = new Set(state.seenUrls ?? []);
        this.directoryErrors = new Map(Object.entries(state.directoryErrors ?? {}));
        this.expandedDirectories = new Set(state.expandedDirectories ?? []);
        this.autoScanCheckpoint = state.checkpoint;
        this.autoScanRootPath = state.autoScan?.rootPath ?? state.checkpoint?.rootPath ?? currentPath();
        this.autoScanIntervalMs = state.autoScan?.intervalMs ?? AUTO_SCAN_DEFAULT_INTERVAL_MS;
        this.autoScanRootInput.value = this.autoScanRootPath;
        this.autoScanIntervalInput.value = String(this.autoScanIntervalMs / 1_000);
        this.autoScanState = state.checkpoint ? "stopped" : "idle";
        this.status.textContent = state.checkpoint
          ? `已恢复 ${this.entries.length} 项；自动扫描有未完成断点`
          : `已恢复 ${this.entries.length} 项，按需展开目录`;
      } else {
        this.favorites = readLegacyFavorites();
      }
      this.render();
      this.updateAutoScanControls();
      await this.requestPersistentStorage();
    } catch (error) {
      this.status.textContent = error instanceof Error ? `恢复失败：${error.message}` : "恢复失败";
    }
  }
  private async requestPersistentStorage(): Promise<void> { if (!navigator.storage?.persist) return; try { const persisted = await navigator.storage.persist(); if (persisted) this.status.textContent = "索引已恢复；浏览器已启用持久化存储"; } catch { /* Persistence is optional and browser-controlled. */ } }
  private async persistState(rootPath: string): Promise<void> {
    const state = {
      id: location.origin,
      rootPath,
      updatedAt: new Date().toISOString(),
      entries: this.entries,
      favorites: [...this.favorites],
      blacklisted: [...this.blacklisted],
      failures: this.failures,
      loadedDirectories: [...this.loadedDirectories],
      directoryPagination: Object.fromEntries(this.directoryPagination),
      directoryLoadedAt: Object.fromEntries(this.directoryLoadedAt),
      seenUrls: [...this.seenUrls],
      directoryErrors: Object.fromEntries(this.directoryErrors),
      expandedDirectories: [...this.expandedDirectories],
      graph: serializeGraph(this.graph),
      autoScan: { rootPath: this.autoScanRootPath, intervalMs: this.autoScanIntervalMs },
      ...(this.autoScanCheckpoint ? { checkpoint: this.autoScanCheckpoint } : {}),
    };
    await saveIndexState(state);
  }
  private exportIndex(): void { downloadJson(createIndexExport({ sourceOrigin: location.origin, rootPath: currentPath(), entries: this.entries, favorites: this.favorites, blacklisted: this.blacklisted, graph: serializeGraph(this.graph), desktopState: { seenUrls: [...this.seenUrls], loadedDirectories: [...this.loadedDirectories], directoryPagination: Object.fromEntries(this.directoryPagination), directoryLoadedAt: Object.fromEntries(this.directoryLoadedAt), expandedDirectories: [...this.expandedDirectories] } }), `asmrgay-index-${new Date().toISOString().slice(0, 10)}.json`); this.status.textContent = `已导出 ${this.entries.length} 项已加载索引`; }
  private exportFavoritesJson(): void { downloadJson({ schemaVersion: 1, exportedAt: new Date().toISOString(), sourceOrigin: location.origin, favorites: [...this.favorites] }, `asmrgay-favorites-${new Date().toISOString().slice(0, 10)}.json`); this.status.textContent = `已导出 ${this.favorites.size} 个收藏`; }
  private exportFavoritesCsv(): void { const rows = [["url", "title", "type"], ...this.entries.filter((entry) => this.favorites.has(entry.url)).map((entry) => [entry.url, entry.title, entry.type])]; const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n"); downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `asmrgay-favorites-${new Date().toISOString().slice(0, 10)}.csv`); this.status.textContent = `已导出 ${this.favorites.size} 个收藏`; }
  private async importIndex(event: Event): Promise<void> {
    if (this.autoScanState === "running" || this.autoScanState === "paused") {
      this.status.textContent = "请先暂停或停止自动扫描，再导入索引";
      return;
    }
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      this.status.textContent = "导入失败：文件超过 20 MB";
      return;
    }
    try {
      const imported = parseIndexExport(JSON.parse(await file.text()) as unknown, location.origin);
      const mode = this.requireElement<HTMLSelectElement>(".abe-import-mode").value;
      if (mode === "replace") {
        this.entries = imported.entries;
        this.graph = imported.graph ? hydrateGraph(imported.graph) : createGraph();
        this.favorites = new Set(imported.favorites);
        this.blacklisted = new Set(imported.blacklisted);
        this.loadedDirectories.clear();
        this.directoryPagination.clear();
        this.directoryLoadedAt.clear();
        this.seenUrls.clear();
        this.expandedDirectories.clear();
      } else {
        this.entries = mergeEntryLists(this.entries, imported.entries);
        if (imported.graph) this.graph = mergeGraphs(this.graph, hydrateGraph(imported.graph));
        this.favorites = new Set([...this.favorites, ...imported.favorites]);
        this.blacklisted = new Set([...this.blacklisted, ...imported.blacklisted]);
      }
      if (imported.desktopState) {
        this.seenUrls = new Set(imported.desktopState.seenUrls);
        this.loadedDirectories = new Set(imported.desktopState.loadedDirectories);
        this.directoryPagination = new Map(Object.entries(imported.desktopState.directoryPagination));
        this.directoryLoadedAt = new Map(Object.entries(imported.desktopState.directoryLoadedAt));
        this.expandedDirectories = new Set(imported.desktopState.expandedDirectories ?? []);
      }
      this.autoScanCheckpoint = undefined;
      this.autoScanState = "idle";
      await this.persistState(imported.rootPath);
      this.status.textContent = `${mode === "replace" ? "替换" : "合并"}导入完成：当前共 ${this.entries.length} 项`;
      this.render();
    } catch (error) {
      this.status.textContent = error instanceof Error ? `导入失败：${error.message}` : "导入失败";
    }
  }
  private exportFailures(): void { if (!this.failures.length) { this.status.textContent = "目前没有失败记录"; return; } downloadJson({ schemaVersion: 1, exportedAt: new Date().toISOString(), sourceOrigin: location.origin, scannerMode: "alist-api", failures: this.failures }, `asmrgay-failures-${new Date().toISOString().slice(0, 10)}.json`); }
  private async clearIndex(): Promise<void> {
    if (this.autoScanState === "running" || this.autoScanState === "paused") {
      this.status.textContent = "请先停止自动扫描，再清空索引";
      return;
    }
    if (!window.confirm("确定清空已加载索引、收藏和黑名单吗？建议先导出备份。")) return;
    this.entries = [];
    this.graph = createGraph();
    this.favorites.clear();
    this.blacklisted.clear();
    this.loadedDirectories.clear();
    this.directoryPagination.clear();
    this.directoryLoadedAt.clear();
    this.seenUrls.clear();
    this.directoryErrors.clear();
    this.expandedDirectories.clear();
    this.failures = [];
    this.autoScanCheckpoint = undefined;
    this.autoScanState = "idle";
    await deleteIndexState(location.origin);
    this.status.textContent = "索引、收藏和黑名单已清空";
    this.render();
    this.updateAutoScanControls();
  }
  private setRefreshDisabled(disabled: boolean): void { this.requireElement<HTMLButtonElement>(".abe-refresh").disabled = disabled; }
  private updatePath(): void { this.pathLabel.textContent = this.selectedDirectory; }
  private requireElement<T extends Element = HTMLElement>(selector: string): T { const element = this.root.querySelector<T>(selector); if (!element) throw new Error(`Missing panel element: ${selector}`); return element; }
}

function normalizePath(path: string): string { try { const decoded = decodeURIComponent(path); return decoded.startsWith("/") ? decoded : `/${decoded}`; } catch { return path.startsWith("/") ? path : `/${path}`; } }
function pathFromUrl(url: string): string { return normalizePath(new URL(url).pathname); }
function urlForPath(path: string): string { return new URL(encodePath(normalizePath(path)), location.origin).href; }
function encodePath(path: string): string { return path.split("/").map((segment) => encodeURIComponent(segment)).join("/"); }
function currentPath(): string { return normalizePath(location.pathname); }
function safeDecode(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }
function readPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_WIDTH_DEFAULT;
    const value = Number(raw);
    return Number.isFinite(value) ? clampPanelWidth(value) : PANEL_WIDTH_DEFAULT;
  } catch {
    return PANEL_WIDTH_DEFAULT;
  }
}
function clampPanelWidth(width: number): number { return Math.round(Math.min(panelWidthMax(), Math.max(PANEL_WIDTH_MIN, width))); }
function panelWidthMax(): number { return typeof window === "undefined" ? PANEL_WIDTH_MAX : Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, window.innerWidth - 24)); }
function readScanInterval(value: string): number | undefined { const milliseconds = Number(value) * 1_000; if (!Number.isFinite(milliseconds) || milliseconds < AUTO_SCAN_MIN_INTERVAL_MS || milliseconds > 3_600_000) return undefined; return Math.round(milliseconds); }
function formatSeconds(milliseconds: number): string { return String(milliseconds / 1_000); }
function pathDepth(rootPath: string, path: string): number { const rootSegments = normalizePath(rootPath).split("/").filter(Boolean); const segments = normalizePath(path).split("/").filter(Boolean); return Math.max(1, segments.length - rootSegments.length + 1); }
function scanDepth(rootPath: string, path: string): number { return Math.max(0, pathDepth(rootPath, path) - 1); }
function isPathWithin(rootPath: string, path: string): boolean { const root = normalizePath(rootPath); const candidate = normalizePath(path); return root === "/" ? candidate.startsWith("/") : candidate === root || candidate.startsWith(`${root}/`); }
function mergeGraphs(left: IndexGraph, right: IndexGraph): IndexGraph { for (const [id, node] of right.nodes) left.nodes.set(id, node); for (const [id, edge] of right.edges) left.edges.set(id, edge); return left; }
function nodeToEntry(node: import("../core/graph.js").IndexNode): DiscoveredEntry { return { url: node.url, title: node.title, type: node.type, metadata: { ...node.metadata, status: node.status, discoveredAt: node.discoveredAt, lastSeenAt: node.lastSeenAt } }; }
function readLegacyFavorites(): Set<string> { try { const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]") as unknown; return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); } catch { return new Set(); } }
function typeEmptyMessage(type: string, hasEntries: boolean): string { if (type === "blacklisted") return "黑名单为空"; return hasEntries ? "没有匹配条目" : "展开目录后建立索引"; }
async function resolveMediaUrl(fileUrl: string, sourceOrigin: string): Promise<string> { const path = decodeURIComponent(new URL(fileUrl).pathname); const response = await fetch(`${sourceOrigin}/api/fs/get`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, password: "" }) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const payload = await response.json() as { code?: number; message?: string; data?: { raw_url?: string } }; if (payload.code !== 200 || !payload.data?.raw_url) throw new Error(payload.message || "接口未返回音频地址"); return payload.data.raw_url; }
function formatSize(bytes: number): string { if (!Number.isFinite(bytes) || bytes <= 0) return ""; const units = ["B", "KB", "MB", "GB", "TB"]; const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`; }
function formatTime(value: string): string { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : ""; }
function csvCell(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
function downloadJson(value: unknown, filename: string): void { downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" }), filename); }
if (!document.querySelector("#asmrgay-browser-enhancer")) new OnDemandPanel();
