"use strict";
(() => {
  // src/core/url.ts
  var DEFAULT_TRACKING_PARAMETERS = /* @__PURE__ */ new Set([
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid"
  ]);
  var UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;
  function normalizeUrl(input, base, options = {}) {
    const url = base === void 0 ? new URL(input) : new URL(input, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`Unsupported URL protocol: ${url.protocol}`);
    }
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (url.protocol === "http:" && options.httpsUpgradeHosts?.has(url.host.toLowerCase())) {
      url.protocol = "https:";
    }
    url.pathname = normalizePercentEncoding(url.pathname || "/");
    url.search = normalizeQuery(url.searchParams, options.trackingParameters);
    return url.href;
  }
  function normalizeQuery(searchParams, extraTrackingParameters) {
    const retained = [...searchParams.entries()].filter(([key]) => !isTrackingParameter(key, extraTrackingParameters)).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey);
      return keyOrder !== 0 ? keyOrder : leftValue.localeCompare(rightValue);
    });
    if (retained.length === 0) {
      return "";
    }
    return `?${retained.map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`).join("&")}`;
  }
  function isTrackingParameter(key, extraTrackingParameters) {
    const normalizedKey = key.toLowerCase();
    return normalizedKey.startsWith("utm_") || DEFAULT_TRACKING_PARAMETERS.has(normalizedKey) || extraTrackingParameters?.has(normalizedKey) === true;
  }
  function encodeQueryPart(value) {
    return normalizePercentEncoding(encodeURIComponent(value));
  }
  function normalizePercentEncoding(value) {
    return value.replace(/%[0-9a-fA-F]{2}/g, (sequence) => {
      const character = String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
      return UNRESERVED_CHARACTER.test(character) ? character : sequence.toUpperCase();
    });
  }

  // src/core/graph.ts
  function createGraph() {
    return { nodes: /* @__PURE__ */ new Map(), edges: /* @__PURE__ */ new Map() };
  }
  function mergeEntries(graph, parentUrl, entries, now = (/* @__PURE__ */ new Date()).toISOString(), replaceParentEdges = true) {
    const parentId = normalizeUrl(parentUrl);
    const existingParent = graph.nodes.get(parentId);
    ensureNode(graph, {
      url: parentId,
      title: existingParent?.title ?? titleFromUrl(parentId),
      type: "directory",
      metadata: {
        ...existingParent?.metadata,
        internalParent: existingParent === void 0 || existingParent.metadata?.internalParent === true
      }
    }, now);
    if (replaceParentEdges) {
      for (const [edgeId, edge] of graph.edges) {
        if (edge.parentId === parentId) graph.edges.delete(edgeId);
      }
    }
    const positionOffset = replaceParentEdges ? 0 : [...graph.edges.values()].filter((edge) => edge.parentId === parentId).reduce((max, edge) => Math.max(max, edge.position + 1), 0);
    entries.forEach((entry, position) => {
      const childId = normalizeUrl(entry.url, parentId);
      ensureNode(graph, {
        ...entry,
        url: childId,
        metadata: { ...entry.metadata, internalParent: false }
      }, now);
      const edgeId = `${parentId}\0${childId}\0${replaceParentEdges ? position : graph.edges.size}`;
      graph.edges.set(edgeId, {
        id: edgeId,
        parentId,
        childId,
        sourceUrl: parentId,
        label: entry.title,
        position: positionOffset + position
      });
    });
  }
  function ensureNode(graph, entry, now) {
    const id = normalizeUrl(entry.url);
    const existing = graph.nodes.get(id);
    const node = {
      id,
      url: id,
      title: entry.title,
      type: entry.type,
      status: "active",
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now
    };
    if (entry.metadata !== void 0 || existing?.metadata !== void 0) {
      node.metadata = { ...existing?.metadata, ...entry.metadata };
    }
    graph.nodes.set(id, node);
  }
  function serializeGraph(graph) {
    return { nodes: [...graph.nodes.values()], edges: [...graph.edges.values()] };
  }
  function hydrateGraph(value) {
    const graph = {
      nodes: new Map((value?.nodes ?? []).map((node) => [node.id, node])),
      edges: new Map((value?.edges ?? []).map((edge) => [edge.id, edge]))
    };
    repairGraphDisplayMetadata(graph);
    return graph;
  }
  function repairGraphDisplayMetadata(graph) {
    const labelsByChild = /* @__PURE__ */ new Map();
    const parentIds = /* @__PURE__ */ new Set();
    for (const edge of graph.edges.values()) {
      parentIds.add(edge.parentId);
      if (!labelsByChild.has(edge.childId)) labelsByChild.set(edge.childId, edge.label);
    }
    for (const node of graph.nodes.values()) {
      const label = labelsByChild.get(node.id);
      if (label) node.title = label;
      node.metadata = {
        ...node.metadata,
        internalParent: parentIds.has(node.id) && !labelsByChild.has(node.id)
      };
    }
  }
  function graphEntries(graph) {
    return [...graph.nodes.values()].filter((node) => node.metadata?.internalParent !== true).map((node) => ({
      url: node.url,
      title: node.title,
      type: node.type,
      metadata: {
        ...node.metadata,
        status: node.status,
        discoveredAt: node.discoveredAt,
        lastSeenAt: node.lastSeenAt
      }
    }));
  }
  function titleFromUrl(value) {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1);
    if (!segment) return "/";
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }
  function childrenOf(graph, parentUrl) {
    const parentId = normalizeUrl(parentUrl);
    const edges = [...graph.edges.values()].filter((edge) => edge.parentId === parentId).sort((left, right) => left.position - right.position);
    const seen = /* @__PURE__ */ new Set();
    const children = [];
    for (const edge of edges) {
      if (seen.has(edge.childId)) continue;
      const node = graph.nodes.get(edge.childId);
      if (node) {
        seen.add(edge.childId);
        children.push(node);
      }
    }
    return children;
  }

  // src/core/schema.ts
  var INDEX_SCHEMA_VERSION = 1;
  var MAX_IMPORT_ENTRIES = 2e4;
  function parseIndexExport(value, expectedOrigin) {
    if (!isRecord(value)) throw new Error("\u5BFC\u5165\u6587\u4EF6\u5FC5\u987B\u662F JSON \u5BF9\u8C61");
    if (value.schemaVersion !== INDEX_SCHEMA_VERSION) {
      throw new Error(`\u4E0D\u652F\u6301\u7684 schemaVersion\uFF1A${String(value.schemaVersion)}`);
    }
    if (value.scannerMode !== "alist-api") throw new Error("\u4E0D\u652F\u6301\u7684\u626B\u63CF\u5668\u6A21\u5F0F");
    if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
      throw new Error("exportedAt \u65E0\u6548");
    }
    if (typeof value.sourceOrigin !== "string") throw new Error("sourceOrigin \u7F3A\u5931");
    const sourceOrigin = normalizeOrigin(value.sourceOrigin);
    if (sourceOrigin !== normalizeOrigin(expectedOrigin)) throw new Error("\u5BFC\u5165\u6587\u4EF6\u6765\u6E90\u57DF\u4E0E\u5F53\u524D\u7AD9\u70B9\u4E0D\u4E00\u81F4");
    if (typeof value.rootPath !== "string") throw new Error("rootPath \u65E0\u6548");
    if (!Array.isArray(value.entries)) throw new Error("entries \u5FC5\u987B\u662F\u6570\u7EC4");
    if (value.entries.length > MAX_IMPORT_ENTRIES) throw new Error(`entries \u8D85\u8FC7 ${MAX_IMPORT_ENTRIES} \u9879\u4E0A\u9650`);
    if (!Array.isArray(value.favorites)) throw new Error("favorites \u5FC5\u987B\u662F\u6570\u7EC4");
    const graph = parseGraph(value.graph, sourceOrigin);
    const desktopState = parseDesktopState(value.desktopState, sourceOrigin);
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      exportedAt: value.exportedAt,
      sourceOrigin,
      scannerMode: "alist-api",
      rootPath: normalizeRootPath(value.rootPath),
      entries: value.entries.map((entry) => parseEntry(entry, sourceOrigin)),
      favorites: value.favorites.map((url) => {
        if (typeof url !== "string") throw new Error("favorites \u542B\u6709\u975E\u5B57\u7B26\u4E32\u5730\u5740");
        return normalizeSameOriginUrl(url, sourceOrigin);
      }),
      ...graph ? { graph } : {},
      ...desktopState ? { desktopState } : {}
    };
  }
  function parseDesktopState(value, origin) {
    if (value === void 0) return void 0;
    if (!isRecord(value) || !Array.isArray(value.seenUrls) || !Array.isArray(value.loadedDirectories) || !isRecord(value.directoryPagination) || !isRecord(value.directoryLoadedAt)) throw new Error("desktopState \u65E0\u6548");
    const seenUrls = value.seenUrls.map((url) => {
      if (typeof url !== "string") throw new Error("seenUrls \u65E0\u6548");
      return normalizeSameOriginUrl(url, origin);
    });
    const loadedDirectories = value.loadedDirectories.map((path) => {
      if (typeof path !== "string") throw new Error("loadedDirectories \u65E0\u6548");
      return normalizeRootPath(path);
    });
    const directoryPagination = {};
    for (const [path, state] of Object.entries(value.directoryPagination)) {
      if (!isRecord(state) || typeof state.nextPage !== "number" || typeof state.loaded !== "number" || typeof state.total !== "number" || typeof state.complete !== "boolean") throw new Error("directoryPagination \u65E0\u6548");
      directoryPagination[normalizeRootPath(path)] = { nextPage: state.nextPage, loaded: state.loaded, total: state.total, complete: state.complete };
    }
    const directoryLoadedAt = {};
    for (const [path, date] of Object.entries(value.directoryLoadedAt)) {
      if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) throw new Error("directoryLoadedAt \u65E0\u6548");
      directoryLoadedAt[normalizeRootPath(path)] = date;
    }
    const expandedDirectories = value.expandedDirectories === void 0 ? void 0 : !Array.isArray(value.expandedDirectories) ? (() => {
      throw new Error("expandedDirectories \u65E0\u6548");
    })() : value.expandedDirectories.map((path) => {
      if (typeof path !== "string") throw new Error("expandedDirectories \u65E0\u6548");
      return normalizeRootPath(path);
    });
    return { seenUrls, loadedDirectories, directoryPagination, directoryLoadedAt, ...expandedDirectories ? { expandedDirectories } : {} };
  }
  function parseGraph(value, origin) {
    if (value === void 0) return void 0;
    if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error("graph \u65E0\u6548");
    const nodes = value.nodes.map((node) => {
      if (!isRecord(node) || typeof node.id !== "string" || typeof node.url !== "string" || typeof node.title !== "string" || !isNodeType(node.type) || node.status !== "active" && node.status !== "missing" || typeof node.discoveredAt !== "string" || typeof node.lastSeenAt !== "string") throw new Error("graph.nodes \u542B\u6709\u65E0\u6548\u8282\u70B9");
      const url = normalizeSameOriginUrl(node.url, origin);
      if (node.id !== url) throw new Error("graph \u8282\u70B9 ID \u4E0E URL \u4E0D\u4E00\u81F4");
      return node;
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = value.edges.map((edge) => {
      if (!isRecord(edge) || typeof edge.id !== "string" || typeof edge.parentId !== "string" || typeof edge.childId !== "string" || typeof edge.sourceUrl !== "string" || typeof edge.label !== "string" || typeof edge.position !== "number") throw new Error("graph.edges \u542B\u6709\u65E0\u6548\u8FB9");
      if (!nodeIds.has(edge.parentId) || !nodeIds.has(edge.childId)) throw new Error("graph \u8FB9\u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u8282\u70B9");
      normalizeSameOriginUrl(edge.sourceUrl, origin);
      return edge;
    });
    return { nodes, edges };
  }
  function parseEntry(value, origin) {
    if (!isRecord(value)) throw new Error("entries \u542B\u6709\u65E0\u6548\u6761\u76EE");
    if (typeof value.url !== "string") throw new Error("\u6761\u76EE URL \u65E0\u6548");
    if (typeof value.title !== "string" || value.title.length === 0 || value.title.length > 2e3) {
      throw new Error("\u6761\u76EE\u6807\u9898\u65E0\u6548");
    }
    if (!isNodeType(value.type)) throw new Error("\u6761\u76EE\u7C7B\u578B\u65E0\u6548");
    const entry = {
      url: normalizeSameOriginUrl(value.url, origin),
      title: value.title,
      type: value.type
    };
    if (value.metadata !== void 0) {
      if (!isJsonRecord(value.metadata)) throw new Error("\u6761\u76EE metadata \u65E0\u6548");
      entry.metadata = value.metadata;
    }
    return entry;
  }
  function normalizeSameOriginUrl(value, origin) {
    const normalized = normalizeUrl(value, origin);
    if (new URL(normalized).origin !== origin) throw new Error("\u7D22\u5F15\u4E2D\u5305\u542B\u7AD9\u5916\u5730\u5740");
    return normalized;
  }
  function normalizeOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("\u6765\u6E90\u57DF\u534F\u8BAE\u65E0\u6548");
    return url.origin;
  }
  function normalizeRootPath(value) {
    if (!value.startsWith("/") || value.length > 4e3) throw new Error("rootPath \u65E0\u6548");
    return value;
  }
  function isNodeType(value) {
    return value === "directory" || value === "content";
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isJsonRecord(value) {
    if (!isRecord(value)) return false;
    try {
      JSON.stringify(value);
      return true;
    } catch {
      return false;
    }
  }

  // src/index-page/main.ts
  var SOURCE_ORIGIN = "https://www.asmrgay.com";
  var STATE_KEY = "viewer-state";
  var MAX_SEARCH_RESULTS = 300;
  var IndexViewer = class {
    graph = createGraph();
    sourceOrigin = SOURCE_ORIGIN;
    rootPath = "/";
    favorites = /* @__PURE__ */ new Set();
    expanded = /* @__PURE__ */ new Set();
    tree = requireElement("#tree");
    status = requireElement("#status");
    count = requireElement("#count");
    search = requireElement("#search");
    filter = requireElement("#filter");
    file = requireElement("#file");
    mode = requireElement("#mode");
    player = requireElement("#player");
    audio = requireElement("#audio");
    playerTitle = requireElement("#player-title");
    playerQueue = requireElement("#player-queue");
    playerFavorite = requireElement("#player-favorite");
    queue = [];
    queueIndex = -1;
    playbackMode = "single";
    queueIsFavorites = false;
    loadRequestId = 0;
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
      this.audio.setAttribute("referrerpolicy", "no-referrer");
      requireElement("#player-mode").addEventListener("change", (event) => {
        const value = event.target.value;
        if (value === "single" || value === "loop" || value === "random") this.playbackMode = value;
      });
      this.audio.addEventListener("ended", () => this.handleEnded());
      this.audio.addEventListener("error", () => {
        this.status.textContent = "\u64AD\u653E\u5931\u8D25\uFF1A\u97F3\u9891\u5730\u5740\u4E0D\u53EF\u7528\u6216\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE";
      });
      void this.restore();
      if ("serviceWorker" in navigator && location.protocol.startsWith("http")) void navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" });
    }
    async importFile(event) {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        const sourceOrigin = readSourceOrigin(raw);
        if (sourceOrigin !== SOURCE_ORIGIN) throw new Error("\u53EA\u652F\u6301 www.asmrgay.com \u5BFC\u51FA\u7684\u7D22\u5F15");
        const imported = parseIndexExport(raw, sourceOrigin);
        const incomingGraph = imported.graph ? hydrateGraph(imported.graph) : graphFromEntries(imported.sourceOrigin, imported.rootPath, imported.entries);
        if (this.mode.value === "replace" || this.graph.nodes.size === 0) {
          this.graph = incomingGraph;
          this.favorites = new Set(imported.favorites);
          this.expanded.clear();
        } else {
          mergeGraphs(this.graph, incomingGraph);
          this.favorites = /* @__PURE__ */ new Set([...this.favorites, ...imported.favorites]);
        }
        this.sourceOrigin = imported.sourceOrigin;
        this.rootPath = imported.rootPath;
        await this.persist();
        this.status.textContent = `\u5BFC\u5165\u5B8C\u6210\uFF1A${graphEntries(this.graph).length} \u9879`;
        this.render();
      } catch (error) {
        this.status.textContent = error instanceof Error ? `\u5BFC\u5165\u5931\u8D25\uFF1A${error.message}` : "\u5BFC\u5165\u5931\u8D25";
      }
    }
    handleTreeClick(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const favoriteButton = target.closest("[data-favorite]");
      if (favoriteButton?.dataset.favorite) {
        const url2 = favoriteButton.dataset.favorite;
        if (this.favorites.has(url2)) this.favorites.delete(url2);
        else this.favorites.add(url2);
        this.refreshPlayerFavorite();
        void this.persist();
        this.render();
        return;
      }
      const toggle = target.closest("[data-toggle]");
      if (!toggle?.dataset.toggle) return;
      const url = toggle.dataset.toggle;
      if (this.expanded.has(url)) this.expanded.delete(url);
      else this.expanded.add(url);
      void this.persist();
      this.render();
    }
    render() {
      this.tree.replaceChildren();
      if (this.graph.nodes.size === 0) {
        this.count.textContent = "0 \u9879";
        this.tree.append(emptyState("\u8BF7\u5148\u5BFC\u5165\u684C\u9762\u7AEF\u5BFC\u51FA\u7684 index.json"));
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
        this.count.textContent = `${matches.length} \u9879`;
        const fragment2 = document.createDocumentFragment();
        for (const entry of matches.slice(0, MAX_SEARCH_RESULTS)) fragment2.append(this.createRow(entry.url, entry.title, entry.type, 0, false));
        if (matches.length > MAX_SEARCH_RESULTS) fragment2.append(emptyState(`\u4EC5\u663E\u793A\u524D ${MAX_SEARCH_RESULTS} \u9879\uFF0C\u8BF7\u7EE7\u7EED\u7F29\u5C0F\u641C\u7D22\u8303\u56F4`));
        this.tree.append(fragment2);
        return;
      }
      const rootUrl = new URL(encodePath(this.rootPath), this.sourceOrigin).href;
      const fragment = document.createDocumentFragment();
      let visibleCount = 0;
      const visit = (parentUrl, depth, ancestors) => {
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
      visit(rootUrl, 0, /* @__PURE__ */ new Set([rootUrl]));
      this.count.textContent = `${visibleCount} \u9879`;
      this.tree.append(fragment.childNodes.length ? fragment : emptyState("\u7D22\u5F15\u4E2D\u6CA1\u6709\u5F53\u524D\u6839\u76EE\u5F55\u7684\u5B50\u9879"));
    }
    createRow(url, title, type, depth, expanded) {
      const row = document.createElement("div");
      row.className = "tree-row";
      row.style.setProperty("--depth", String(depth));
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "toggle";
      toggle.textContent = type === "directory" ? expanded ? "\u25BE" : "\u25B8" : "\u266A";
      if (type === "directory") toggle.dataset.toggle = url;
      else toggle.disabled = true;
      const link = document.createElement("a");
      link.href = url;
      if (type === "directory") {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = title;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = type === "directory" ? "\u76EE\u5F55" : "\u6587\u4EF6";
      link.append(name, meta);
      if (type === "content") link.addEventListener("click", (event) => {
        event.preventDefault();
        this.playTrack(url);
      });
      const favorite = document.createElement("button");
      favorite.type = "button";
      favorite.className = "favorite";
      favorite.dataset.favorite = url;
      favorite.dataset.active = String(this.favorites.has(url));
      favorite.textContent = "\u2605";
      favorite.title = this.favorites.has(url) ? "\u53D6\u6D88\u6536\u85CF" : "\u6536\u85CF";
      row.append(toggle, link, favorite);
      return row;
    }
    playTrack(url) {
      const node = this.graph.nodes.get(url);
      if (!node || node.type !== "content") return;
      const parent = [...this.graph.edges.values()].find((edge) => edge.childId === url)?.parentId;
      const queue = parent ? childrenOf(this.graph, parent).filter((item) => item.type === "content" && item.status === "active") : [node];
      this.queueIsFavorites = false;
      this.setQueue(queue.length ? queue : [node], url);
    }
    playFavorites() {
      const queue = [...this.graph.nodes.values()].filter((node) => node.type === "content" && node.status === "active" && this.favorites.has(node.url));
      if (!queue.length) {
        this.status.textContent = "\u6682\u65E0\u6536\u85CF\u97F3\u9891";
        return;
      }
      this.queueIsFavorites = true;
      this.setQueue(queue, queue[0].url);
    }
    setQueue(queue, url) {
      this.queue = queue;
      this.queueIndex = Math.max(0, queue.findIndex((node) => node.url === url));
      this.player.classList.remove("hidden");
      void this.loadCurrentTrack(true);
    }
    async loadCurrentTrack(autoplay) {
      const node = this.queue[this.queueIndex];
      if (!node) return;
      const requestId = ++this.loadRequestId;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.playerTitle.textContent = node.title;
      this.refreshPlayerFavorite();
      this.playerQueue.textContent = `${this.queueIndex + 1} / ${this.queue.length}${this.queueIsFavorites ? " \xB7 \u6536\u85CF\u5217\u8868" : " \xB7 \u5F53\u524D\u76EE\u5F55"}`;
      this.status.textContent = "\u6B63\u5728\u83B7\u53D6\u64AD\u653E\u5730\u5740\u2026";
      try {
        const mediaUrl = await resolveMediaUrl(node.url, this.sourceOrigin);
        if (requestId !== this.loadRequestId) return;
        this.audio.src = mediaUrl;
        this.audio.load();
        this.status.textContent = "\u64AD\u653E\u5730\u5740\u5DF2\u5C31\u7EEA";
        if (autoplay) void this.audio.play().catch(() => {
          this.status.textContent = "\u8BF7\u70B9\u51FB\u64AD\u653E\u5668\u7684\u64AD\u653E\u6309\u94AE\u5F00\u59CB\u64AD\u653E";
        });
      } catch (error) {
        if (requestId !== this.loadRequestId) return;
        this.status.textContent = error instanceof Error ? `\u64AD\u653E\u5730\u5740\u83B7\u53D6\u5931\u8D25\uFF1A${error.message}` : "\u64AD\u653E\u5730\u5740\u83B7\u53D6\u5931\u8D25";
      }
    }
    playRelative(offset) {
      if (!this.queue.length) return;
      if (this.playbackMode === "random") this.queueIndex = randomIndex(this.queue.length, this.queueIndex);
      else this.queueIndex = (this.queueIndex + offset + this.queue.length) % this.queue.length;
      void this.loadCurrentTrack(true);
    }
    handleEnded() {
      if (this.playbackMode === "single") return;
      this.playRelative(1);
    }
    toggleCurrentFavorite() {
      const node = this.queue[this.queueIndex];
      if (!node) return;
      if (this.favorites.has(node.url)) this.favorites.delete(node.url);
      else this.favorites.add(node.url);
      if (this.queueIsFavorites && !this.favorites.has(node.url)) {
        const next = this.queue[(this.queueIndex + 1) % this.queue.length]?.url;
        this.queue = this.queue.filter((item) => item.url !== node.url);
        if (!this.queue.length) this.closePlayer();
        else {
          this.queueIndex = Math.max(0, this.queue.findIndex((item) => item.url === next));
          void this.loadCurrentTrack(false);
        }
      }
      this.refreshPlayerFavorite();
      void this.persist();
      this.render();
    }
    refreshPlayerFavorite() {
      const node = this.queue[this.queueIndex];
      this.playerFavorite.textContent = node && this.favorites.has(node.url) ? "\u53D6\u6D88\u6536\u85CF" : "\u6536\u85CF";
    }
    closePlayer() {
      this.loadRequestId += 1;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.player.classList.add("hidden");
    }
    async restore() {
      try {
        const state = await loadState();
        if (state) {
          this.graph = hydrateGraph(state.graph);
          this.sourceOrigin = state.sourceOrigin;
          this.rootPath = state.rootPath;
          this.favorites = new Set(state.favorites);
          this.expanded = new Set(state.expanded);
          this.status.textContent = `\u5DF2\u6062\u590D ${graphEntries(this.graph).length} \u9879\u672C\u5730\u7D22\u5F15`;
        }
      } catch {
        this.status.textContent = "\u672C\u5730\u7D22\u5F15\u6062\u590D\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u5BFC\u5165";
      }
      this.render();
    }
    async persist() {
      await saveState({ sourceOrigin: this.sourceOrigin, rootPath: this.rootPath, graph: serializeGraph(this.graph), favorites: [...this.favorites], expanded: [...this.expanded] });
    }
  };
  function graphFromEntries(origin, rootPath, entries) {
    const graph = createGraph();
    mergeEntries(graph, new URL(encodePath(rootPath), origin).href, entries);
    return graph;
  }
  function mergeGraphs(left, right) {
    for (const [id, node] of right.nodes) left.nodes.set(id, node);
    for (const [id, edge] of right.edges) left.edges.set(id, edge);
  }
  function readSourceOrigin(value) {
    if (typeof value !== "object" || value === null || !("sourceOrigin" in value) || typeof value.sourceOrigin !== "string") throw new Error("sourceOrigin \u7F3A\u5931");
    return new URL(value.sourceOrigin).origin;
  }
  function encodePath(path) {
    return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  }
  function emptyState(message) {
    const element = document.createElement("div");
    element.className = "empty";
    element.textContent = message;
    return element;
  }
  function requireElement(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  }
  function randomIndex(length, current) {
    if (length < 2) return current;
    let next = current;
    while (next === current) next = Math.floor(Math.random() * length);
    return next;
  }
  async function resolveMediaUrl(fileUrl, sourceOrigin) {
    const path = decodeURIComponent(new URL(fileUrl).pathname);
    const response = await fetch(`${sourceOrigin}/api/fs/get`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, password: "" }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== 200 || !payload.data?.raw_url) throw new Error(payload.message || "\u63A5\u53E3\u672A\u8FD4\u56DE\u97F3\u9891\u5730\u5740");
    return payload.data.raw_url;
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("asmrgay-index-viewer", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function loadState() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction("state").objectStore("state").get(STATE_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }
  async function saveState(state) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("state", "readwrite");
        transaction.objectStore("state").put(state, STATE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }
  new IndexViewer();
})();
