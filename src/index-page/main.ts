import { childrenOf, createGraph, graphEntries, hydrateGraph, mergeEntries, serializeGraph } from "../core/graph.js";
import type { IndexGraph, IndexNode, SerializedGraph } from "../core/graph.js";
import { parseIndexExport } from "../core/schema.js";

const SOURCE_ORIGIN = "https://www.asmrgay.com";
const STATE_KEY = "viewer-state";
const MAX_SEARCH_RESULTS = 300;
type PlaybackMode = "single" | "loop" | "random";

interface ViewerState {
  sourceOrigin: string;
  rootPath: string;
  graph: SerializedGraph;
  favorites: string[];
  expanded: string[];
}

class IndexViewer {
  private graph: IndexGraph = createGraph();
  private sourceOrigin = SOURCE_ORIGIN;
  private rootPath = "/";
  private favorites = new Set<string>();
  private expanded = new Set<string>();
  private readonly tree = requireElement<HTMLElement>("#tree");
  private readonly status = requireElement<HTMLElement>("#status");
  private readonly count = requireElement<HTMLElement>("#count");
  private readonly search = requireElement<HTMLInputElement>("#search");
  private readonly filter = requireElement<HTMLSelectElement>("#filter");
  private readonly file = requireElement<HTMLInputElement>("#file");
  private readonly mode = requireElement<HTMLSelectElement>("#mode");
  private readonly player = requireElement<HTMLElement>("#player");
  private readonly audio = requireElement<HTMLAudioElement>("#audio");
  private readonly playerTitle = requireElement<HTMLElement>("#player-title");
  private readonly playerQueue = requireElement<HTMLElement>("#player-queue");
  private readonly playerFavorite = requireElement<HTMLButtonElement>("#player-favorite");
  private queue: IndexNode[] = [];
  private queueIndex = -1;
  private playbackMode: PlaybackMode = "single";
  private queueIsFavorites = false;

  constructor() {
    requireElement("#import").addEventListener("click", () => this.file.click());
    this.file.addEventListener("change", (event) => void this.importFile(event));
    this.search.addEventListener("input", () => this.render());
    this.filter.addEventListener("change", () => this.render());
    this.tree.addEventListener("click", (event) => this.handleTreeClick(event));
    requireElement("#play-favorites").addEventListener("click", () => this.playFavorites());
    requireElement("#player-close").addEventListener("click", () => this.closePlayer());
    requireElement("#player-prev").addEventListener("click", () => this.playRelative(-1));
    requireElement("#player-next").addEventListener("click", () => this.playRelative(1));
    this.playerFavorite.addEventListener("click", () => this.toggleCurrentFavorite());
    requireElement<HTMLSelectElement>("#player-mode").addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value === "single" || value === "loop" || value === "random") this.playbackMode = value;
    });
    this.audio.addEventListener("ended", () => this.handleEnded());
    this.audio.addEventListener("error", () => { this.status.textContent = "播放失败：音频地址不可用或暂时无法访问"; });
    void this.restore();
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) void navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" });
  }

  private async importFile(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      const sourceOrigin = readSourceOrigin(raw);
      if (sourceOrigin !== SOURCE_ORIGIN) throw new Error("只支持 www.asmrgay.com 导出的索引");
      const imported = parseIndexExport(raw, sourceOrigin);
      const incomingGraph = imported.graph ? hydrateGraph(imported.graph) : graphFromEntries(imported.sourceOrigin, imported.rootPath, imported.entries);
      if (this.mode.value === "replace" || this.graph.nodes.size === 0) {
        this.graph = incomingGraph;
        this.favorites = new Set(imported.favorites);
        this.expanded.clear();
      } else {
        mergeGraphs(this.graph, incomingGraph);
        this.favorites = new Set([...this.favorites, ...imported.favorites]);
      }
      this.sourceOrigin = imported.sourceOrigin;
      this.rootPath = imported.rootPath;
      await this.persist();
      this.status.textContent = `导入完成：${graphEntries(this.graph).length} 项`;
      this.render();
    } catch (error) {
      this.status.textContent = error instanceof Error ? `导入失败：${error.message}` : "导入失败";
    }
  }

  private handleTreeClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const favoriteButton = target.closest<HTMLButtonElement>("[data-favorite]");
    if (favoriteButton?.dataset.favorite) {
      const url = favoriteButton.dataset.favorite;
      if (this.favorites.has(url)) this.favorites.delete(url); else this.favorites.add(url);
      this.refreshPlayerFavorite();
      void this.persist();
      this.render();
      return;
    }
    const toggle = target.closest<HTMLButtonElement>("[data-toggle]");
    if (!toggle?.dataset.toggle) return;
    const url = toggle.dataset.toggle;
    if (this.expanded.has(url)) this.expanded.delete(url); else this.expanded.add(url);
    void this.persist();
    this.render();
  }

  private render(): void {
    this.tree.replaceChildren();
    if (this.graph.nodes.size === 0) {
      this.count.textContent = "0 项";
      this.tree.append(emptyState("请先导入桌面端导出的 index.json"));
      return;
    }
    const query = this.search.value.trim().toLocaleLowerCase();
    const filter = this.filter.value;
    const entries = graphEntries(this.graph);
    if (query || filter !== "all") {
      const matches = entries.filter((entry) => {
        const typeMatch = filter === "favorite" ? this.favorites.has(entry.url) : filter === "all" || entry.type === filter;
        return typeMatch && (!query || `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query));
      });
      this.count.textContent = `${matches.length} 项`;
      const fragment = document.createDocumentFragment();
      for (const entry of matches.slice(0, MAX_SEARCH_RESULTS)) fragment.append(this.createRow(entry.url, entry.title, entry.type, 0, false));
      if (matches.length > MAX_SEARCH_RESULTS) fragment.append(emptyState(`仅显示前 ${MAX_SEARCH_RESULTS} 项，请继续缩小搜索范围`));
      this.tree.append(fragment);
      return;
    }
    const rootUrl = new URL(encodePath(this.rootPath), this.sourceOrigin).href;
    const fragment = document.createDocumentFragment();
    let visibleCount = 0;
    const visit = (parentUrl: string, depth: number, ancestors: ReadonlySet<string>): void => {
      for (const node of childrenOf(this.graph, parentUrl)) {
        if (ancestors.has(node.url)) continue;
        const expanded = node.type === "directory" && this.expanded.has(node.url);
        fragment.append(this.createRow(node.url, node.title, node.type, depth, expanded));
        visibleCount += 1;
        if (!expanded) continue;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(node.url);
        visit(node.url, depth + 1, nextAncestors);
      }
    };
    visit(rootUrl, 0, new Set([rootUrl]));
    this.count.textContent = `${visibleCount} 项`;
    this.tree.append(fragment.childNodes.length ? fragment : emptyState("索引中没有当前根目录的子项"));
  }

  private createRow(url: string, title: string, type: "directory" | "content", depth: number, expanded: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.setProperty("--depth", String(depth));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "toggle";
    toggle.textContent = type === "directory" ? (expanded ? "▾" : "▸") : "♪";
    if (type === "directory") toggle.dataset.toggle = url; else toggle.disabled = true;
    const link = document.createElement("a");
    link.href = url;
    if (type === "directory") { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    const name = document.createElement("span"); name.className = "name"; name.textContent = title;
    const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = type === "directory" ? "目录" : "文件";
    link.append(name, meta);
    if (type === "content") link.addEventListener("click", (event) => { event.preventDefault(); this.playTrack(url); });
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = "favorite";
    favorite.dataset.favorite = url;
    favorite.dataset.active = String(this.favorites.has(url));
    favorite.textContent = "★";
    favorite.title = this.favorites.has(url) ? "取消收藏" : "收藏";
    row.append(toggle, link, favorite);
    return row;
  }

  private playTrack(url: string): void {
    const node = this.graph.nodes.get(url);
    if (!node || node.type !== "content") return;
    const parent = [...this.graph.edges.values()].find((edge) => edge.childId === url)?.parentId;
    const queue = parent ? childrenOf(this.graph, parent).filter((item) => item.type === "content" && item.status === "active") : [node];
    this.queueIsFavorites = false;
    this.setQueue(queue.length ? queue : [node], url);
  }

  private playFavorites(): void {
    const queue = [...this.graph.nodes.values()].filter((node) => node.type === "content" && node.status === "active" && this.favorites.has(node.url));
    if (!queue.length) { this.status.textContent = "暂无收藏音频"; return; }
    this.queueIsFavorites = true;
    this.setQueue(queue, queue[0]!.url);
  }

  private setQueue(queue: IndexNode[], url: string): void {
    this.queue = queue;
    this.queueIndex = Math.max(0, queue.findIndex((node) => node.url === url));
    this.player.classList.remove("hidden");
    this.loadCurrentTrack(true);
  }

  private loadCurrentTrack(autoplay: boolean): void {
    const node = this.queue[this.queueIndex];
    if (!node) return;
    this.audio.src = node.url;
    this.audio.load();
    this.playerTitle.textContent = node.title;
    this.refreshPlayerFavorite();
    this.playerQueue.textContent = `${this.queueIndex + 1} / ${this.queue.length}${this.queueIsFavorites ? " · 收藏列表" : " · 当前目录"}`;
    if (autoplay) void this.audio.play().catch(() => { this.status.textContent = "请点击播放器的播放按钮开始播放"; });
  }

  private playRelative(offset: number): void {
    if (!this.queue.length) return;
    if (this.playbackMode === "random") this.queueIndex = randomIndex(this.queue.length, this.queueIndex);
    else this.queueIndex = (this.queueIndex + offset + this.queue.length) % this.queue.length;
    this.loadCurrentTrack(true);
  }

  private handleEnded(): void {
    if (this.playbackMode === "single") return;
    this.playRelative(1);
  }

  private toggleCurrentFavorite(): void {
    const node = this.queue[this.queueIndex];
    if (!node) return;
    if (this.favorites.has(node.url)) this.favorites.delete(node.url); else this.favorites.add(node.url);
    if (this.queueIsFavorites && !this.favorites.has(node.url)) {
      const next = this.queue[(this.queueIndex + 1) % this.queue.length]?.url;
      this.queue = this.queue.filter((item) => item.url !== node.url);
      if (!this.queue.length) this.closePlayer();
      else { this.queueIndex = Math.max(0, this.queue.findIndex((item) => item.url === next)); this.loadCurrentTrack(false); }
    }
    this.refreshPlayerFavorite();
    void this.persist();
    this.render();
  }

  private refreshPlayerFavorite(): void {
    const node = this.queue[this.queueIndex];
    this.playerFavorite.textContent = node && this.favorites.has(node.url) ? "取消收藏" : "收藏";
  }

  private closePlayer(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.player.classList.add("hidden");
  }

  private async restore(): Promise<void> {
    try {
      const state = await loadState();
      if (state) {
        this.graph = hydrateGraph(state.graph);
        this.sourceOrigin = state.sourceOrigin;
        this.rootPath = state.rootPath;
        this.favorites = new Set(state.favorites);
        this.expanded = new Set(state.expanded);
        this.status.textContent = `已恢复 ${graphEntries(this.graph).length} 项本地索引`;
      }
    } catch { this.status.textContent = "本地索引恢复失败，请重新导入"; }
    this.render();
  }

  private async persist(): Promise<void> {
    await saveState({ sourceOrigin: this.sourceOrigin, rootPath: this.rootPath, graph: serializeGraph(this.graph), favorites: [...this.favorites], expanded: [...this.expanded] });
  }
}

function graphFromEntries(origin: string, rootPath: string, entries: ReturnType<typeof graphEntries>): IndexGraph {
  const graph = createGraph();
  mergeEntries(graph, new URL(encodePath(rootPath), origin).href, entries);
  return graph;
}
function mergeGraphs(left: IndexGraph, right: IndexGraph): void { for (const [id, node] of right.nodes) left.nodes.set(id, node); for (const [id, edge] of right.edges) left.edges.set(id, edge); }
function readSourceOrigin(value: unknown): string { if (typeof value !== "object" || value === null || !("sourceOrigin" in value) || typeof value.sourceOrigin !== "string") throw new Error("sourceOrigin 缺失"); return new URL(value.sourceOrigin).origin; }
function encodePath(path: string): string { return path.split("/").map((segment) => encodeURIComponent(segment)).join("/"); }
function emptyState(message: string): HTMLElement { const element = document.createElement("div"); element.className = "empty"; element.textContent = message; return element; }
function requireElement<T extends Element = HTMLElement>(selector: string): T { const element = document.querySelector<T>(selector); if (!element) throw new Error(`Missing element: ${selector}`); return element; }
function randomIndex(length: number, current: number): number { if (length < 2) return current; let next = current; while (next === current) next = Math.floor(Math.random() * length); return next; }

function openDatabase(): Promise<IDBDatabase> { return new Promise((resolve, reject) => { const request = indexedDB.open("asmrgay-index-viewer", 1); request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state"); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function loadState(): Promise<ViewerState | undefined> { const database = await openDatabase(); try { return await new Promise((resolve, reject) => { const request = database.transaction("state").objectStore("state").get(STATE_KEY); request.onsuccess = () => resolve(request.result as ViewerState | undefined); request.onerror = () => reject(request.error); }); } finally { database.close(); } }
async function saveState(state: ViewerState): Promise<void> { const database = await openDatabase(); try { await new Promise<void>((resolve, reject) => { const transaction = database.transaction("state", "readwrite"); transaction.objectStore("state").put(state, STATE_KEY); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); } finally { database.close(); } }

new IndexViewer();
