import { childrenOf, createGraph, directChildren, graphEntries, hydrateGraph, mergeEntries, reconcileDirectoryChildren, serializeGraph, setNodeType } from "../core/graph.js";
import type { DiscoveredEntry, IndexGraph, NodeType } from "../core/graph.js";
import { createIndexExport, mergeEntryLists, parseIndexExport } from "../core/schema.js";
import { scanAListDirectory, type FailureRecord } from "../scanner/alist.js";
import { deleteIndexState, loadIndexState, saveIndexState } from "../storage/index-store.js";
import { PANEL_STYLES } from "./styles.js";

const FAVORITES_KEY = "asmrgay-enhancer:favorites:v1";
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

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
  private entries: DiscoveredEntry[] = [];
  private graph: IndexGraph = createGraph();
  private favorites = new Set<string>();
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
  private expandedDirectories = new Set<string>();
  private visibleRows: VisibleTreeRow[] = [];

  constructor() {
    const host = document.createElement("div");
    host.id = "asmrgay-browser-enhancer";
    document.documentElement.append(host);
    this.root = host.attachShadow({ mode: "open" });
    this.root.innerHTML = this.template();
    this.panel = this.requireElement(".abe-panel");
    this.list = this.requireElement(".abe-list");
    this.status = this.requireElement(".abe-status");
    this.count = this.requireElement(".abe-count");
    this.pathLabel = this.requireElement(".abe-path");
    this.searchInput = this.requireElement<HTMLInputElement>(".abe-search");
    this.typeSelect = this.requireElement<HTMLSelectElement>(".abe-type");
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
        <div class="abe-controls"><input class="abe-search" type="search" placeholder="搜索已加载目录"><select class="abe-type"><option value="all">全部</option><option value="directory">目录</option><option value="content">文件</option><option value="favorite">收藏</option><option value="seen">已看</option><option value="unseen">未看</option></select></div>
        <nav class="abe-breadcrumbs"></nav><div class="abe-list"><div class="abe-empty">展开目录后建立索引</div></div>
      </section>`;
  }

  private bindEvents(): void {
    this.requireElement(".abe-launcher").addEventListener("click", () => { this.panel.classList.remove("abe-hidden"); void this.ensureDirectory(currentPath(), false); });
    this.requireElement(".abe-close").addEventListener("click", () => this.panel.classList.add("abe-hidden"));
    this.requireElement(".abe-refresh").addEventListener("click", () => void this.ensureDirectory(this.selectedDirectory, true));
    this.searchInput.addEventListener("input", () => this.render());
    this.typeSelect.addEventListener("change", () => this.render());
    this.list.addEventListener("click", (event) => this.handleListClick(event));
    this.requireElement(".abe-export").addEventListener("click", () => this.exportIndex());
    this.requireElement(".abe-export-favorites").addEventListener("click", () => this.exportFavoritesJson());
    this.requireElement(".abe-export-csv").addEventListener("click", () => this.exportFavoritesCsv());
    this.requireElement(".abe-import").addEventListener("click", () => this.requireElement<HTMLInputElement>(".abe-file").click());
    this.requireElement<HTMLInputElement>(".abe-file").addEventListener("change", (event) => void this.importIndex(event));
    this.requireElement(".abe-failures").addEventListener("click", () => this.exportFailures());
    this.requireElement(".abe-clear").addEventListener("click", () => void this.clearIndex());
    window.setInterval(() => this.updatePath(), 500);
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

  private handleListClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;
    if (action === "expand" && path) {
      this.toggleDirectory(path);
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
    const button = target.closest<HTMLButtonElement>(".abe-favorite");
    const url = button?.dataset.url;
    if (!button || !url) return;
    if (this.favorites.has(url)) this.favorites.delete(url); else this.favorites.add(url);
    void this.persistState(currentPath()); this.render();
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
    const query = this.searchInput.value.trim().toLocaleLowerCase();
    const type = this.typeSelect.value;
    const scopedEntries = query || type === "favorite" || type === "seen" || type === "unseen"
      ? this.entries
      : childrenOf(this.graph, new URL(encodePath(this.selectedDirectory), location.origin).href).map(nodeToEntry);
    const filtered = scopedEntries.filter((entry) => {
      const matchesType = type === "favorite" ? this.favorites.has(entry.url) : type === "seen" ? this.seenUrls.has(entry.url) : type === "unseen" ? !this.seenUrls.has(entry.url) : type === "all" || entry.type === type;
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
    this.list.replaceChildren();
    if (!this.visibleRows.length) { const empty = document.createElement("div"); empty.className = "abe-empty"; empty.textContent = this.entries.length ? "没有匹配条目" : "展开目录后建立索引"; this.list.append(empty); return; }
    const fragment = document.createDocumentFragment();
    for (const row of this.visibleRows) fragment.append(this.createTreeRow(row));
    this.list.append(fragment);
  }

  private renderBreadcrumbs(): void {
    const container = this.requireElement(".abe-breadcrumbs"); container.replaceChildren();
    const root = document.createElement("button"); root.type = "button"; root.textContent = "/"; root.addEventListener("click", () => { this.selectedDirectory = "/"; void this.ensureDirectory("/", false); }); container.append(root);
    let path = ""; for (const segment of this.selectedDirectory.split("/").filter(Boolean)) { path += `/${segment}`; const separator = document.createElement("span"); separator.textContent = " / "; const button = document.createElement("button"); button.type = "button"; button.textContent = safeDecode(segment); const target = path; button.addEventListener("click", () => { this.selectedDirectory = target; void this.ensureDirectory(target, false); }); container.append(separator, button); }
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
    const kind = document.createElement("button"); kind.type = "button"; kind.className = "abe-kind"; kind.dataset.action = entry.type === "directory" ? "expand" : "noop"; kind.dataset.path = entry.type === "directory" ? pathFromUrl(entry.url) : ""; kind.textContent = entry.type === "directory" ? (row.expanded ? "▾" : "▸") : "♪"; kind.title = entry.type === "directory" ? (row.expanded ? "收起目录" : "展开目录") : "文件";
    const link = document.createElement("a"); link.className = "abe-link"; link.href = entry.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    const name = document.createElement("span"); name.className = "abe-name"; name.textContent = entry.title;
    const meta = document.createElement("span"); meta.className = "abe-meta"; meta.textContent = entry.type === "directory" ? (this.loadedDirectories.has(pathFromUrl(entry.url)) ? `目录 · 已加载${this.directoryLoadedAt.get(pathFromUrl(entry.url)) ? ` · ${formatTime(this.directoryLoadedAt.get(pathFromUrl(entry.url))!)}` : ""}` : "目录 · 点击展开") : formatSize(Number(entry.metadata?.size)) || "文件"; if (entry.metadata?.status === "missing") meta.textContent += " · 已失效"; if (this.seenUrls.has(entry.url)) meta.textContent += " · 已看"; link.append(name, meta); link.addEventListener("click", (event) => { if (entry.type === "directory" && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); this.toggleDirectory(pathFromUrl(entry.url)); return; } this.seenUrls.add(entry.url); void this.persistState(this.selectedDirectory); });
    const actions = document.createElement("span"); actions.className = "abe-row-actions";
    const favorite = document.createElement("button"); favorite.type = "button"; favorite.className = "abe-favorite"; favorite.dataset.url = entry.url; favorite.dataset.active = String(this.favorites.has(entry.url)); favorite.title = this.favorites.has(entry.url) ? "取消收藏" : "收藏"; favorite.textContent = "★";
    const reclassify = document.createElement("button"); reclassify.type = "button"; reclassify.className = "abe-reclassify"; reclassify.dataset.url = entry.url; reclassify.title = "切换目录/文件分类"; reclassify.textContent = "↔";
    actions.append(favorite, reclassify); element.append(kind, link, actions); return element;
  }

  private async restoreState(): Promise<void> { try { const state = await loadIndexState(location.origin); if (state) { this.graph = state.graph ? hydrateGraph(state.graph) : createGraph(); this.entries = state.graph ? graphEntries(this.graph) : state.entries; this.favorites = new Set(state.favorites); this.loadedDirectories = new Set(state.loadedDirectories ?? []); this.directoryPagination = new Map(Object.entries(state.directoryPagination ?? {})); this.directoryLoadedAt = new Map(Object.entries(state.directoryLoadedAt ?? {})); this.failures = state.failures ?? []; this.seenUrls = new Set(state.seenUrls ?? []); this.directoryErrors = new Map(Object.entries(state.directoryErrors ?? {})); this.expandedDirectories = new Set(state.expandedDirectories ?? []); this.status.textContent = `已恢复 ${this.entries.length} 项，按需展开目录`; } else this.favorites = readLegacyFavorites(); this.render(); await this.requestPersistentStorage(); } catch (error) { this.status.textContent = error instanceof Error ? `恢复失败：${error.message}` : "恢复失败"; } }
  private async requestPersistentStorage(): Promise<void> { if (!navigator.storage?.persist) return; try { const persisted = await navigator.storage.persist(); if (persisted) this.status.textContent = "索引已恢复；浏览器已启用持久化存储"; } catch { /* Persistence is optional and browser-controlled. */ } }
  private async persistState(rootPath: string): Promise<void> { await saveIndexState({ id: location.origin, rootPath, updatedAt: new Date().toISOString(), entries: this.entries, favorites: [...this.favorites], failures: this.failures, loadedDirectories: [...this.loadedDirectories], directoryPagination: Object.fromEntries(this.directoryPagination), directoryLoadedAt: Object.fromEntries(this.directoryLoadedAt), seenUrls: [...this.seenUrls], directoryErrors: Object.fromEntries(this.directoryErrors), expandedDirectories: [...this.expandedDirectories], graph: serializeGraph(this.graph) }); }
  private exportIndex(): void { downloadJson(createIndexExport({ sourceOrigin: location.origin, rootPath: currentPath(), entries: this.entries, favorites: this.favorites, graph: serializeGraph(this.graph), desktopState: { seenUrls: [...this.seenUrls], loadedDirectories: [...this.loadedDirectories], directoryPagination: Object.fromEntries(this.directoryPagination), directoryLoadedAt: Object.fromEntries(this.directoryLoadedAt), expandedDirectories: [...this.expandedDirectories] } }), `asmrgay-index-${new Date().toISOString().slice(0, 10)}.json`); this.status.textContent = `已导出 ${this.entries.length} 项已加载索引`; }
  private exportFavoritesJson(): void { downloadJson({ schemaVersion: 1, exportedAt: new Date().toISOString(), sourceOrigin: location.origin, favorites: [...this.favorites] }, `asmrgay-favorites-${new Date().toISOString().slice(0, 10)}.json`); this.status.textContent = `已导出 ${this.favorites.size} 个收藏`; }
  private exportFavoritesCsv(): void { const rows = [["url", "title", "type"], ...this.entries.filter((entry) => this.favorites.has(entry.url)).map((entry) => [entry.url, entry.title, entry.type])]; const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n"); downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `asmrgay-favorites-${new Date().toISOString().slice(0, 10)}.csv`); this.status.textContent = `已导出 ${this.favorites.size} 个收藏`; }
  private async importIndex(event: Event): Promise<void> { const input = event.target; if (!(input instanceof HTMLInputElement)) return; const file = input.files?.[0]; input.value = ""; if (!file) return; if (file.size > MAX_IMPORT_BYTES) { this.status.textContent = "导入失败：文件超过 20 MB"; return; } try { const imported = parseIndexExport(JSON.parse(await file.text()) as unknown, location.origin); const mode = this.requireElement<HTMLSelectElement>(".abe-import-mode").value; if (mode === "replace") { this.entries = imported.entries; this.graph = imported.graph ? hydrateGraph(imported.graph) : createGraph(); this.favorites = new Set(imported.favorites); this.loadedDirectories.clear(); this.directoryPagination.clear(); this.directoryLoadedAt.clear(); this.seenUrls.clear(); this.expandedDirectories.clear(); } else { this.entries = mergeEntryLists(this.entries, imported.entries); if (imported.graph) this.graph = mergeGraphs(this.graph, hydrateGraph(imported.graph)); this.favorites = new Set([...this.favorites, ...imported.favorites]); } if (imported.desktopState) { this.seenUrls = new Set(imported.desktopState.seenUrls); this.loadedDirectories = new Set(imported.desktopState.loadedDirectories); this.directoryPagination = new Map(Object.entries(imported.desktopState.directoryPagination)); this.directoryLoadedAt = new Map(Object.entries(imported.desktopState.directoryLoadedAt)); this.expandedDirectories = new Set(imported.desktopState.expandedDirectories ?? []); } await this.persistState(imported.rootPath); this.status.textContent = `${mode === "replace" ? "替换" : "合并"}导入完成：当前共 ${this.entries.length} 项`; this.render(); } catch (error) { this.status.textContent = error instanceof Error ? `导入失败：${error.message}` : "导入失败"; } }
  private exportFailures(): void { if (!this.failures.length) { this.status.textContent = "目前没有失败记录"; return; } downloadJson({ schemaVersion: 1, exportedAt: new Date().toISOString(), sourceOrigin: location.origin, scannerMode: "alist-api", failures: this.failures }, `asmrgay-failures-${new Date().toISOString().slice(0, 10)}.json`); }
  private async clearIndex(): Promise<void> { if (!window.confirm("确定清空已加载索引和收藏吗？建议先导出备份。")) return; this.entries = []; this.graph = createGraph(); this.favorites.clear(); this.loadedDirectories.clear(); this.directoryPagination.clear(); this.directoryLoadedAt.clear(); this.seenUrls.clear(); this.directoryErrors.clear(); this.expandedDirectories.clear(); this.failures = []; await deleteIndexState(location.origin); this.status.textContent = "索引和收藏已清空"; this.render(); }
  private setRefreshDisabled(disabled: boolean): void { this.requireElement<HTMLButtonElement>(".abe-refresh").disabled = disabled; }
  private updatePath(): void { this.pathLabel.textContent = this.selectedDirectory; }
  private requireElement<T extends Element = HTMLElement>(selector: string): T { const element = this.root.querySelector<T>(selector); if (!element) throw new Error(`Missing panel element: ${selector}`); return element; }
}

function normalizePath(path: string): string { try { const decoded = decodeURIComponent(path); return decoded.startsWith("/") ? decoded : `/${decoded}`; } catch { return path.startsWith("/") ? path : `/${path}`; } }
function pathFromUrl(url: string): string { return normalizePath(new URL(url).pathname); }
function encodePath(path: string): string { return path.split("/").map((segment) => encodeURIComponent(segment)).join("/"); }
function currentPath(): string { return normalizePath(location.pathname); }
function safeDecode(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }
function mergeGraphs(left: IndexGraph, right: IndexGraph): IndexGraph { for (const [id, node] of right.nodes) left.nodes.set(id, node); for (const [id, edge] of right.edges) left.edges.set(id, edge); return left; }
function nodeToEntry(node: import("../core/graph.js").IndexNode): DiscoveredEntry { return { url: node.url, title: node.title, type: node.type, metadata: { ...node.metadata, status: node.status, discoveredAt: node.discoveredAt, lastSeenAt: node.lastSeenAt } }; }
function readLegacyFavorites(): Set<string> { try { const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]") as unknown; return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); } catch { return new Set(); } }
function formatSize(bytes: number): string { if (!Number.isFinite(bytes) || bytes <= 0) return ""; const units = ["B", "KB", "MB", "GB", "TB"]; const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`; }
function formatTime(value: string): string { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : ""; }
function csvCell(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
function downloadJson(value: unknown, filename: string): void { downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" }), filename); }
if (!document.querySelector("#asmrgay-browser-enhancer")) new OnDemandPanel();
