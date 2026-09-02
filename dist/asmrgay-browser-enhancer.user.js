// ==UserScript==
// @name         ASMRGay Browser Enhancer
// @namespace    local.asmrgay.browser-enhancer
// @version      0.1.0
// @description  为 ASMRGay 增加当前目录索引、搜索、筛选和收藏
// @match        https://www.asmrgay.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
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
  function directChildren(graph, parentUrl) {
    const parentId = normalizeUrl(parentUrl);
    return new Set([...graph.edges.values()].filter((edge) => edge.parentId === parentId).map((edge) => edge.childId));
  }
  function reconcileDirectoryChildren(graph, previousChildIds, observedChildIds, lastSeenAt = (/* @__PURE__ */ new Date()).toISOString()) {
    for (const id of previousChildIds) {
      const node = graph.nodes.get(id);
      if (node && !observedChildIds.has(id)) node.status = "missing";
    }
    for (const id of observedChildIds) {
      const node = graph.nodes.get(id);
      if (node) {
        node.status = "active";
        node.lastSeenAt = lastSeenAt;
      }
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
  function setNodeType(graph, url, type) {
    const node = graph.nodes.get(normalizeUrl(url));
    if (node) {
      node.type = type;
      node.metadata = { ...node.metadata, manuallyClassified: true };
    }
  }

  // src/core/schema.ts
  var INDEX_SCHEMA_VERSION = 1;
  var MAX_IMPORT_ENTRIES = 2e4;
  function createIndexExport(input) {
    const sourceOrigin = normalizeOrigin(input.sourceOrigin);
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      exportedAt: input.exportedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      sourceOrigin,
      scannerMode: "alist-api",
      rootPath: normalizeRootPath(input.rootPath),
      entries: input.entries.map((entry) => sanitizeEntry(entry, sourceOrigin)),
      favorites: [...input.favorites].map((url) => normalizeSameOriginUrl(url, sourceOrigin)),
      blacklisted: [...input.blacklisted ?? []].map((url) => normalizeSameOriginUrl(url, sourceOrigin)),
      ...input.graph ? { graph: input.graph } : {},
      ...input.desktopState ? { desktopState: sanitizeDesktopState(input.desktopState, sourceOrigin) } : {}
    };
  }
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
    if (value.blacklisted !== void 0 && !Array.isArray(value.blacklisted)) throw new Error("blacklisted \u5FC5\u987B\u662F\u6570\u7EC4");
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
      blacklisted: (value.blacklisted ?? []).map((url) => {
        if (typeof url !== "string") throw new Error("blacklisted \u542B\u6709\u975E\u5B57\u7B26\u4E32\u5730\u5740");
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
  function sanitizeDesktopState(value, origin) {
    return parseDesktopState(value, origin);
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
  function mergeEntryLists(current, incoming) {
    const merged = /* @__PURE__ */ new Map();
    for (const entry of current) merged.set(entry.url, entry);
    for (const entry of incoming) merged.set(entry.url, entry);
    return [...merged.values()];
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
  function sanitizeEntry(entry, origin) {
    return parseEntry(entry, origin);
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

  // src/core/classify.ts
  var MEDIA_EXTENSIONS = /\.(?:mp3|m4a|wav|flac|ogg|mp4|mkv|webm|avi|jpg|jpeg|png|gif|zip|7z|rar|pdf)$/i;
  function classifyEntry(signals) {
    if (signals.isDirectory) return "directory";
    if (signals.hasMediaElement || MEDIA_EXTENSIONS.test(signals.name)) return "content";
    if ((signals.childCount ?? 0) > 0 || signals.hasPagination) return "directory";
    return "content";
  }

  // src/scanner/alist.ts
  async function scanAListDirectory(path, options = {}) {
    const pageSize = options.pageSize ?? 100;
    const startPage = options.startPage ?? 1;
    const maxPages = options.maxPages ?? 20;
    const entries = [];
    const failures = [];
    let total = 0;
    let pagesLoaded = 0;
    for (let page = startPage; page < startPage + maxPages; page += 1) {
      options.signal?.throwIfAborted();
      const payload = await requestPage(path, page, pageSize, options, (failure) => {
        failures.push(failure);
        options.onFailure?.(failure);
      });
      const pageItems = payload.data?.content ?? [];
      total = payload.data?.total ?? 0;
      entries.push(...pageItems.map((item) => toDiscoveredEntry(path, item)));
      pagesLoaded += 1;
      options.onProgress?.({ loaded: entries.length, total, page });
      if (pageItems.length === 0 || entries.length >= total) break;
      if (page < startPage + maxPages - 1) await waitWithJitter(options.delayMs ?? 500, options.jitterMs ?? 500, options.signal);
    }
    return { path, entries, total, truncated: entries.length < total, failures, startPage, pagesLoaded };
  }
  async function requestPage(path, page, pageSize, options, onFailure) {
    const maxRetries = options.maxRetries ?? 3;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      options.signal?.throwIfAborted();
      try {
        const init = { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, password: "", page, per_page: pageSize, refresh: false }) };
        if (options.signal) init.signal = options.signal;
        const response = await fetch("/api/fs/list", init);
        const contentType = response.headers.get("Content-Type") ?? "";
        const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
        if (response.ok && contentType.toLowerCase().includes("application/json")) {
          const payload = await response.json();
          if (payload.code === 200 && payload.data) return payload;
          throw new Error(payload.message || `\u76EE\u5F55\u63A5\u53E3\u9519\u8BEF\uFF1A${payload.code}`);
        }
        const responseText = contentType.toLowerCase().includes("application/json") ? "" : await response.text();
        const cloudflare1015 = /Error\s*1015|being rate limited/i.test(responseText);
        const transient = response.status === 429 || response.status >= 500;
        const kind = cloudflare1015 || response.status === 429 ? "429" : response.status >= 500 ? "5xx" : contentType.toLowerCase().includes("json") ? "invalid-response" : "permanent";
        const message = cloudflare1015 ? "Cloudflare 1015\uFF1A\u5F53\u524D\u7F51\u7EDC\u5DF2\u88AB\u4E34\u65F6\u9650\u6D41\uFF0C\u8BF7\u505C\u6B62\u8BF7\u6C42\u5E76\u7A0D\u540E\u518D\u8BD5" : response.ok ? `\u76EE\u5F55\u63A5\u53E3\u8FD4\u56DE\u975E JSON \u5185\u5BB9\uFF1A${contentType || "\u672A\u77E5\u7C7B\u578B"}` : transient ? `HTTP ${response.status}` : `\u76EE\u5F55\u63A5\u53E3\u8FD4\u56DE ${contentType || "\u672A\u77E5\u7C7B\u578B"}`;
        const failure = { path, status: response.status, kind, message, attempts: attempt, occurredAt: (/* @__PURE__ */ new Date()).toISOString() };
        if (retryAfterMs !== void 0) failure.retryAfterMs = retryAfterMs;
        onFailure(failure);
        if (!transient || attempt > maxRetries) throw new Error(failure.message);
        await waitWithJitter(retryAfterMs ?? Math.min(options.backoffCapMs ?? 3e4, (options.backoffBaseMs ?? 1e3) * 2 ** (attempt - 1)), options.jitterMs ?? 500, options.signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        if (error instanceof Error && (/^目录接口返回/.test(error.message) || /^目录接口错误/.test(error.message) || /^Cloudflare 1015/.test(error.message))) throw error;
        if (error instanceof Error && /HTTP 429|HTTP 5\d\d/.test(error.message) && attempt <= maxRetries) continue;
        if (attempt > maxRetries) break;
        const failure = { path, kind: "network", message: error instanceof Error ? error.message : "\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25", attempts: attempt, occurredAt: (/* @__PURE__ */ new Date()).toISOString() };
        onFailure(failure);
        await waitWithJitter(Math.min(options.backoffCapMs ?? 3e4, (options.backoffBaseMs ?? 1e3) * 2 ** (attempt - 1)), options.jitterMs ?? 500, options.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("\u76EE\u5F55\u8BF7\u6C42\u5931\u8D25");
  }
  function toDiscoveredEntry(path, item) {
    return { url: normalizeUrl(buildItemUrl(path, item.name)), title: item.name, type: classifyEntry({ isDirectory: item.is_dir, name: item.name }), metadata: { size: item.size, modified: item.modified, alistType: item.type } };
  }
  function buildItemUrl(path, name) {
    const origin = typeof location === "undefined" ? "https://www.asmrgay.com" : location.origin;
    return new URL(`${path.endsWith("/") ? path : `${path}/`}${encodeURIComponent(name)}`, origin);
  }
  function parseRetryAfter(value) {
    if (!value) return void 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : void 0;
  }
  async function waitWithJitter(delayMs, jitterMs, signal) {
    const duration = delayMs + Math.floor(Math.random() * (jitterMs + 1));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, duration);
      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(signal.reason);
      }, { once: true });
    });
  }
  function isAbortError(error) {
    return error instanceof DOMException && error.name === "AbortError";
  }

  // src/storage/index-store.ts
  var DATABASE_NAME = "asmrgay-browser-enhancer";
  var DATABASE_VERSION = 1;
  var STORE_NAME = "index-state";
  async function loadIndexState(id) {
    const database = await openDatabase();
    try {
      return await requestAsPromise(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(id));
    } finally {
      database.close();
    }
  }
  async function saveIndexState(state) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(state);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
  async function deleteIndexState(id) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("\u65E0\u6CD5\u6253\u5F00 IndexedDB"));
    });
  }
  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB \u8BF7\u6C42\u5931\u8D25"));
    });
  }
  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB \u4E8B\u52A1\u5931\u8D25"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB \u4E8B\u52A1\u5DF2\u4E2D\u6B62"));
    });
  }

  // src/userscript/styles.ts
  var PANEL_STYLES = `
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
    width: min(460px, 100vw); background: #f7f8fa; color: #20242a;
    border-right: 1px solid #cfd5dc; box-shadow: 8px 0 28px rgba(0,0,0,.18);
    display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; font: 14px/1.4 system-ui, sans-serif;
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
  .abe-data-menu summary::after { content: " \u25BE"; color: #78818a; }
  .abe-data-menu[open] summary { background: #edf1f5; }
  .abe-data-actions { position: absolute; top: calc(100% + 6px); right: 0; z-index: 10; width: 300px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 9px; background: #fff; border: 1px solid #cbd2d9; border-radius: 7px; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
  .abe-secondary { min-height: 30px; border: 1px solid #bac3cc; border-radius: 5px; background: #fff; color: #303942; padding: 4px 7px; cursor: pointer; }
  .abe-secondary:hover { background: #edf1f5; }
  .abe-import-mode { min-height: 30px; border: 1px solid #bac3cc; border-radius: 5px; background: #fff; color: #303942; padding: 4px 6px; }
  .abe-clear { color: #9b2f2f; border-color: #d7b5b5; }
  .abe-controls { display: grid; grid-template-columns: 1fr 100px; gap: 7px; padding: 7px 10px; background: #fff; border-bottom: 1px solid #dfe3e8; }
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
  .abe-empty { padding: 32px 20px; text-align: center; color: #69717c; }
  .abe-player { padding: 10px; border-top: 1px solid #cbd5df; background: #fff; box-shadow: 0 -3px 12px rgba(0,0,0,.08); }
  .abe-player-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .abe-player-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .abe-player .abe-icon-button { flex: 0 0 auto; width: 28px; height: 28px; }
  .abe-audio { display: block; width: 100%; height: 36px; }
  .abe-row { display: grid; grid-template-columns: 28px minmax(0,1fr) 98px; align-items: center; min-height: 48px; padding: 4px 10px 4px 14px; border-bottom: 1px solid #e5e8ec; background: #fff; content-visibility: auto; contain-intrinsic-size: 48px; }
  .abe-row:hover { background: #f0f5f9; }
  .abe-kind { width: 28px; height: 36px; border: 0; background: transparent; color: #68727d; padding: 0; font-size: 18px; cursor: default; }
  .abe-kind[data-action="expand"] { cursor: pointer; }
  .abe-kind[data-action="expand"]:hover { color: #1769aa; background: #e5eef5; border-radius: 4px; }
  .abe-link { min-width: 0; color: #165f9b; text-decoration: none; }
  .abe-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abe-meta { display: block; color: #747d87; font-size: 12px; }
  .abe-favorite { border: 0; background: transparent; color: #8a929b; width: 32px; height: 32px; cursor: pointer; font-size: 20px; }
  .abe-favorite[data-active="true"] { color: #d58a00; }
  .abe-blacklist { border: 0; background: transparent; color: #8a929b; width: 28px; height: 32px; cursor: pointer; font-size: 18px; }
  .abe-blacklist[data-active="true"] { color: #b43d3d; }
  .abe-row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 3px; }
  .abe-reclassify { border: 0; background: transparent; color: #7a848d; width: 28px; height: 32px; cursor: pointer; font-size: 16px; }
  @media (max-width: 520px) {
    .abe-launcher { left: 12px; bottom: 72px; }
    .abe-panel { width: 100vw; }
    .abe-status { display: none; }
    .abe-toolbar { grid-template-columns: auto 1fr auto; }
    .abe-progress { justify-self: end; }
  }
`;

  // src/userscript/main.ts
  var FAVORITES_KEY = "asmrgay-enhancer:favorites:v1";
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  var OnDemandPanel = class {
    root;
    panel;
    list;
    status;
    count;
    pathLabel;
    searchInput;
    typeSelect;
    player;
    playerTitle;
    audio;
    entries = [];
    graph = createGraph();
    favorites = /* @__PURE__ */ new Set();
    blacklisted = /* @__PURE__ */ new Set();
    loadedDirectories = /* @__PURE__ */ new Set();
    directoryPagination = /* @__PURE__ */ new Map();
    loadingDirectories = /* @__PURE__ */ new Set();
    failures = [];
    selectedDirectory = currentPath();
    seenUrls = /* @__PURE__ */ new Set();
    directoryErrors = /* @__PURE__ */ new Map();
    filteredEntries = [];
    directoryLoadedAt = /* @__PURE__ */ new Map();
    pendingRefreshChildren = /* @__PURE__ */ new Map();
    blacklistPending = /* @__PURE__ */ new Set();
    expandedDirectories = /* @__PURE__ */ new Set();
    visibleRows = [];
    audioRequestId = 0;
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
      this.searchInput = this.requireElement(".abe-search");
      this.typeSelect = this.requireElement(".abe-type");
      this.player = document.createElement("section");
      this.player.className = "abe-player abe-hidden";
      this.player.setAttribute("aria-label", "\u97F3\u9891\u64AD\u653E\u5668");
      this.player.innerHTML = '<div class="abe-player-top"><strong class="abe-player-title">\u672A\u9009\u62E9\u97F3\u9891</strong><button class="abe-icon-button abe-player-close" type="button" aria-label="\u5173\u95ED\u64AD\u653E\u5668">\xD7</button></div><audio class="abe-audio" controls preload="metadata"></audio>';
      this.panel.append(this.player);
      this.playerTitle = this.requireElement(".abe-player-title");
      this.audio = this.requireElement(".abe-audio");
      this.bindEvents();
      this.updatePath();
      void this.restoreState();
    }
    template() {
      return `<style>${PANEL_STYLES}</style>
      <button class="abe-launcher" type="button" title="\u6253\u5F00\u76EE\u5F55\u7D22\u5F15">\u7D22</button>
      <section class="abe-panel abe-hidden" aria-label="ASMRGay \u6309\u9700\u76EE\u5F55\u7D22\u5F15">
        <header class="abe-header"><div class="abe-title"><strong>\u6309\u9700\u76EE\u5F55\u7D22\u5F15</strong><span class="abe-path"></span></div><button class="abe-icon-button abe-close" type="button" aria-label="\u5173\u95ED">\xD7</button></header>
        <div class="abe-toolbar"><button class="abe-primary abe-refresh" type="button" title="\u91CD\u65B0\u8BF7\u6C42\u5F53\u524D\u76EE\u5F55\u7B2C\u4E00\u9875">\u21BB \u5237\u65B0</button><span class="abe-status">\u4EC5\u5728\u5C55\u5F00\u6216\u5237\u65B0\u65F6\u8BF7\u6C42</span><span class="abe-progress"><span class="abe-count"></span> \u9879</span><details class="abe-data-menu"><summary>\u6570\u636E</summary><div class="abe-data-actions"><button type="button" class="abe-secondary abe-export">\u5BFC\u51FA\u7D22\u5F15</button><button type="button" class="abe-secondary abe-export-favorites">\u6536\u85CF JSON</button><button type="button" class="abe-secondary abe-export-csv">\u6536\u85CF CSV</button><select class="abe-import-mode" aria-label="\u5BFC\u5165\u6A21\u5F0F"><option value="merge">\u5408\u5E76\u5BFC\u5165</option><option value="replace">\u66FF\u6362\u5BFC\u5165</option></select><button type="button" class="abe-secondary abe-import">\u5BFC\u5165\u7D22\u5F15</button><button type="button" class="abe-secondary abe-failures">\u5931\u8D25\u65E5\u5FD7</button><button type="button" class="abe-secondary abe-clear">\u6E05\u7A7A\u7D22\u5F15</button><input class="abe-file abe-hidden" type="file" accept="application/json,.json"></div></details></div>
        <div class="abe-controls"><input class="abe-search" type="search" placeholder="\u641C\u7D22\u5DF2\u52A0\u8F7D\u76EE\u5F55"><select class="abe-type"><option value="all">\u5168\u90E8</option><option value="directory">\u76EE\u5F55</option><option value="content">\u6587\u4EF6</option><option value="favorite">\u6536\u85CF</option><option value="seen">\u5DF2\u770B</option><option value="unseen">\u672A\u770B</option><option value="blacklisted">\u9ED1\u540D\u5355</option></select></div>
        <nav class="abe-breadcrumbs"></nav><div class="abe-list"><div class="abe-empty">\u5C55\u5F00\u76EE\u5F55\u540E\u5EFA\u7ACB\u7D22\u5F15</div></div>
      </section>`;
    }
    bindEvents() {
      this.requireElement(".abe-launcher").addEventListener("click", () => {
        this.panel.classList.remove("abe-hidden");
        void this.ensureDirectory(currentPath(), false);
      });
      this.requireElement(".abe-close").addEventListener("click", () => this.panel.classList.add("abe-hidden"));
      this.requireElement(".abe-refresh").addEventListener("click", () => void this.ensureDirectory(this.selectedDirectory, true));
      this.searchInput.addEventListener("input", () => this.render());
      this.typeSelect.addEventListener("change", () => this.render());
      this.list.addEventListener("click", (event) => this.handleListClick(event));
      this.requireElement(".abe-export").addEventListener("click", () => this.exportIndex());
      this.requireElement(".abe-export-favorites").addEventListener("click", () => this.exportFavoritesJson());
      this.requireElement(".abe-export-csv").addEventListener("click", () => this.exportFavoritesCsv());
      this.requireElement(".abe-import").addEventListener("click", () => this.requireElement(".abe-file").click());
      this.requireElement(".abe-file").addEventListener("change", (event) => void this.importIndex(event));
      this.requireElement(".abe-failures").addEventListener("click", () => this.exportFailures());
      this.requireElement(".abe-clear").addEventListener("click", () => void this.clearIndex());
      this.requireElement(".abe-player-close").addEventListener("click", () => this.closePlayer());
      this.audio.setAttribute("referrerpolicy", "no-referrer");
      this.audio.addEventListener("error", () => {
        this.status.textContent = "\u64AD\u653E\u5931\u8D25\uFF1A\u97F3\u9891\u5730\u5740\u4E0D\u53EF\u7528\u6216\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE";
      });
      window.setInterval(() => this.updatePath(), 500);
    }
    async ensureDirectory(path, force) {
      const normalized = normalizePath(path);
      if (this.loadingDirectories.has(normalized)) return;
      const pagination = this.directoryPagination.get(normalized);
      if (!force && pagination?.complete) {
        this.status.textContent = "\u5DF2\u4F7F\u7528\u7F13\u5B58\uFF1B\u70B9\u51FB\u5237\u65B0\u5F53\u524D\u76EE\u5F55\u53EF\u91CD\u65B0\u8BF7\u6C42";
        this.render();
        return;
      }
      const startPage = force ? 1 : pagination?.nextPage ?? 1;
      if (force && startPage === 1) {
        this.pendingRefreshChildren.set(normalized, directChildren(this.graph, new URL(encodePath(normalized), location.origin).href));
      }
      this.loadingDirectories.add(normalized);
      this.status.textContent = force ? "\u6B63\u5728\u5237\u65B0\u5F53\u524D\u76EE\u5F55\u2026" : "\u6B63\u5728\u8BFB\u53D6\u5F53\u524D\u76EE\u5F55\u2026";
      this.setRefreshDisabled(true);
      try {
        const result = await scanAListDirectory(normalized, { pageSize: 100, startPage, maxPages: 1, maxRetries: 0, delayMs: 0, jitterMs: 0, onFailure: (failure) => this.failures.push(failure) });
        const scopedEntries = result.entries.map((entry) => ({ ...entry, metadata: { ...entry.metadata, parentPath: normalized } }));
        mergeEntries(this.graph, new URL(encodePath(normalized), location.origin).href, scopedEntries, (/* @__PURE__ */ new Date()).toISOString(), force || startPage === 1);
        this.entries = graphEntries(this.graph);
        this.loadedDirectories.add(normalized);
        const previousLoaded = force ? 0 : pagination?.loaded ?? 0;
        this.directoryPagination.set(normalized, { nextPage: startPage + result.pagesLoaded, loaded: previousLoaded + result.entries.length, total: result.total, complete: previousLoaded + result.entries.length >= result.total || result.entries.length === 0 });
        this.directoryLoadedAt.set(normalized, (/* @__PURE__ */ new Date()).toISOString());
        this.directoryErrors.delete(normalized);
        const state = this.directoryPagination.get(normalized);
        if (state.complete) {
          const parentId = new URL(encodePath(normalized), location.origin).href;
          reconcileDirectoryChildren(this.graph, this.pendingRefreshChildren.get(normalized) ?? /* @__PURE__ */ new Set(), directChildren(this.graph, parentId));
          this.pendingRefreshChildren.delete(normalized);
          this.entries = graphEntries(this.graph);
        }
        this.failures.push(...result.failures);
        await this.persistState(normalized);
        this.status.textContent = state.complete ? `\u76EE\u5F55\u5DF2\u52A0\u8F7D\u5B8C\uFF0C\u5171 ${state.loaded} \u9879` : `\u5DF2\u52A0\u8F7D ${state.loaded} / ${state.total} \u9879\uFF1B\u53EF\u70B9\u51FB\u201C\u52A0\u8F7D\u66F4\u591A\u201D`;
      } catch (error) {
        const failure = { path: normalized, kind: /1015|rate limited/i.test(error instanceof Error ? error.message : "") ? "429" : "network", message: error instanceof Error ? error.message : "\u8BFB\u53D6\u76EE\u5F55\u5931\u8D25", attempts: 1, occurredAt: (/* @__PURE__ */ new Date()).toISOString() };
        this.directoryErrors.set(normalized, failure);
        this.failures.push(failure);
        this.status.textContent = failure.message;
      } finally {
        this.loadingDirectories.delete(normalized);
        this.setRefreshDisabled(false);
        this.render();
      }
    }
    handleListClick(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest("[data-action]")?.dataset.action;
      const path = target.closest("[data-path]")?.dataset.path;
      if (action === "expand" && path) {
        this.toggleDirectory(path);
        return;
      }
      if (action === "load-more" && path) {
        void this.ensureDirectory(path, false);
        return;
      }
      if (action === "retry" && path) {
        void this.ensureDirectory(path, false);
        return;
      }
      const reclassify = target.closest(".abe-reclassify");
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
      const blacklist = target.closest(".abe-blacklist");
      const blacklistUrl = blacklist?.dataset.url;
      if (blacklist && blacklistUrl) {
        const entry = this.entries.find((item) => item.url === blacklistUrl);
        if (entry && !this.blacklistPending.has(entry.url)) {
          blacklist.disabled = true;
          void this.toggleBlacklist(entry);
        }
        return;
      }
      const button = target.closest(".abe-favorite");
      const url = button?.dataset.url;
      if (!button || !url) return;
      if (this.favorites.has(url)) this.favorites.delete(url);
      else this.favorites.add(url);
      void this.persistState(currentPath());
      this.render();
    }
    toggleDirectory(path) {
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
    render() {
      const query = this.searchInput.value.trim().toLocaleLowerCase();
      const type = this.typeSelect.value;
      const scopedEntries = query || type === "favorite" || type === "seen" || type === "unseen" || type === "blacklisted" ? this.entries : childrenOf(this.graph, new URL(encodePath(this.selectedDirectory), location.origin).href).map(nodeToEntry);
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
    flattenTree() {
      const rows = [];
      const rootUrl = new URL(encodePath(this.selectedDirectory), location.origin).href;
      const visit = (parentUrl, depth, ancestors) => {
        for (const node of childrenOf(this.graph, parentUrl)) {
          if (ancestors.has(node.url)) continue;
          if (this.blacklisted.has(node.url)) continue;
          const entry = nodeToEntry(node);
          const path = pathFromUrl(entry.url);
          const expanded = entry.type === "directory" && this.expandedDirectories.has(path);
          rows.push({ kind: "entry", entry, depth, expanded });
          if (entry.type !== "directory" || !expanded) continue;
          const error = this.directoryErrors.get(path);
          if (error) {
            rows.push({ kind: "error", path, depth: depth + 1, failure: error });
            continue;
          }
          if (this.loadingDirectories.has(path)) {
            rows.push({ kind: "loading", path, depth: depth + 1 });
            continue;
          }
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(node.url);
          visit(node.url, depth + 1, nextAncestors);
          const page = this.directoryPagination.get(path);
          if (page && !page.complete) rows.push({ kind: "load-more", path, depth: depth + 1, loaded: page.loaded, total: page.total });
        }
      };
      visit(rootUrl, 0, /* @__PURE__ */ new Set([rootUrl]));
      return rows;
    }
    renderWindow() {
      const scrollTop = this.list.scrollTop;
      this.list.replaceChildren();
      if (!this.visibleRows.length) {
        const empty = document.createElement("div");
        empty.className = "abe-empty";
        empty.textContent = typeEmptyMessage(this.typeSelect.value, this.entries.length > 0);
        this.list.append(empty);
        this.list.scrollTop = scrollTop;
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const row of this.visibleRows) fragment.append(this.createTreeRow(row));
      this.list.append(fragment);
      this.list.scrollTop = scrollTop;
    }
    renderBreadcrumbs() {
      const container = this.requireElement(".abe-breadcrumbs");
      container.replaceChildren();
      const root = document.createElement("button");
      root.type = "button";
      root.textContent = "/";
      root.addEventListener("click", () => {
        this.selectedDirectory = "/";
        void this.ensureDirectory("/", false);
      });
      container.append(root);
      let path = "";
      for (const segment of this.selectedDirectory.split("/").filter(Boolean)) {
        path += `/${segment}`;
        const separator = document.createElement("span");
        separator.textContent = " / ";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = safeDecode(segment);
        const target = path;
        button.addEventListener("click", () => {
          this.selectedDirectory = target;
          void this.ensureDirectory(target, false);
        });
        container.append(separator, button);
      }
    }
    createTreeRow(row) {
      if (row.kind === "load-more") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "abe-load-more";
        button.dataset.action = "load-more";
        button.dataset.path = row.path;
        button.style.paddingLeft = `${14 + row.depth * 22}px`;
        button.textContent = `\u21B3 \u52A0\u8F7D\u66F4\u591A\uFF08${row.loaded} / ${row.total}\uFF09`;
        return button;
      }
      if (row.kind === "loading") {
        const element2 = document.createElement("div");
        element2.className = "abe-tree-loading";
        element2.style.paddingLeft = `${14 + row.depth * 22}px`;
        element2.textContent = "\u6B63\u5728\u8BFB\u53D6\u2026";
        return element2;
      }
      if (row.kind === "error") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "abe-tree-error";
        button.dataset.action = "retry";
        button.dataset.path = row.path;
        button.style.paddingLeft = `${14 + row.depth * 22}px`;
        button.textContent = `\u26A0 ${row.failure.message} \xB7 \u70B9\u51FB\u91CD\u8BD5`;
        return button;
      }
      const entry = row.entry;
      const element = document.createElement("div");
      element.className = "abe-row";
      element.style.paddingLeft = `${14 + row.depth * 22}px`;
      const kind = document.createElement("button");
      kind.type = "button";
      kind.className = "abe-kind";
      kind.dataset.action = entry.type === "directory" ? "expand" : "noop";
      kind.dataset.path = entry.type === "directory" ? pathFromUrl(entry.url) : "";
      kind.textContent = entry.type === "directory" ? row.expanded ? "\u25BE" : "\u25B8" : "\u266A";
      kind.title = entry.type === "directory" ? row.expanded ? "\u6536\u8D77\u76EE\u5F55" : "\u5C55\u5F00\u76EE\u5F55" : "\u6587\u4EF6";
      const link = document.createElement("a");
      link.className = "abe-link";
      link.href = entry.url;
      if (entry.type === "directory") {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      const name = document.createElement("span");
      name.className = "abe-name";
      name.textContent = entry.title;
      const meta = document.createElement("span");
      meta.className = "abe-meta";
      meta.textContent = entry.type === "directory" ? this.loadedDirectories.has(pathFromUrl(entry.url)) ? `\u76EE\u5F55 \xB7 \u5DF2\u52A0\u8F7D${this.directoryLoadedAt.get(pathFromUrl(entry.url)) ? ` \xB7 ${formatTime(this.directoryLoadedAt.get(pathFromUrl(entry.url)))}` : ""}` : "\u76EE\u5F55 \xB7 \u70B9\u51FB\u5C55\u5F00" : formatSize(Number(entry.metadata?.size)) || "\u6587\u4EF6";
      if (entry.metadata?.status === "missing") meta.textContent += " \xB7 \u5DF2\u5931\u6548";
      if (this.seenUrls.has(entry.url)) meta.textContent += " \xB7 \u5DF2\u770B";
      link.append(name, meta);
      link.addEventListener("click", (event) => {
        if (entry.type === "directory" && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          this.toggleDirectory(pathFromUrl(entry.url));
          return;
        }
        if (entry.type === "content") {
          event.preventDefault();
          this.seenUrls.add(entry.url);
          void this.persistState(this.selectedDirectory);
          void this.playAudio(entry.url, entry.title);
          return;
        }
        this.seenUrls.add(entry.url);
        void this.persistState(this.selectedDirectory);
      });
      const actions = document.createElement("span");
      actions.className = "abe-row-actions";
      const favorite = document.createElement("button");
      favorite.type = "button";
      favorite.className = "abe-favorite";
      favorite.dataset.url = entry.url;
      favorite.dataset.active = String(this.favorites.has(entry.url));
      favorite.title = this.favorites.has(entry.url) ? "\u53D6\u6D88\u6536\u85CF" : "\u6536\u85CF";
      favorite.textContent = "\u2605";
      const blacklisted = this.blacklisted.has(entry.url);
      const blacklist = document.createElement("button");
      blacklist.type = "button";
      blacklist.className = "abe-blacklist";
      blacklist.dataset.url = entry.url;
      blacklist.dataset.active = String(blacklisted);
      blacklist.title = blacklisted ? "\u79FB\u51FA\u9ED1\u540D\u5355" : "\u52A0\u5165\u9ED1\u540D\u5355";
      blacklist.setAttribute("aria-label", blacklist.title);
      blacklist.textContent = blacklisted ? "\u21A9" : "\u2298";
      const reclassify = document.createElement("button");
      reclassify.type = "button";
      reclassify.className = "abe-reclassify";
      reclassify.dataset.url = entry.url;
      reclassify.title = "\u5207\u6362\u76EE\u5F55/\u6587\u4EF6\u5206\u7C7B";
      reclassify.textContent = "\u2194";
      actions.append(favorite, blacklist, reclassify);
      element.append(kind, link, actions);
      return element;
    }
    async toggleBlacklist(entry) {
      if (this.blacklistPending.has(entry.url)) return;
      this.blacklistPending.add(entry.url);
      const active = this.blacklisted.has(entry.url);
      try {
        if (active) this.blacklisted.delete(entry.url);
        else this.blacklisted.add(entry.url);
        try {
          await this.persistState(this.selectedDirectory);
        } catch (error) {
          this.status.textContent = error instanceof Error ? `\u9ED1\u540D\u5355\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}` : "\u9ED1\u540D\u5355\u4FDD\u5B58\u5931\u8D25";
        }
      } finally {
        this.blacklistPending.delete(entry.url);
        this.render();
      }
    }
    async playAudio(url, title) {
      const requestId = ++this.audioRequestId;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.playerTitle.textContent = title;
      this.player.classList.remove("abe-hidden");
      this.status.textContent = "\u6B63\u5728\u83B7\u53D6\u64AD\u653E\u5730\u5740\u2026";
      try {
        const mediaUrl = await resolveMediaUrl(url, location.origin);
        if (requestId !== this.audioRequestId) return;
        this.audio.src = mediaUrl;
        this.audio.load();
        this.status.textContent = "\u64AD\u653E\u5730\u5740\u5DF2\u5C31\u7EEA";
        void this.audio.play().catch(() => {
          this.status.textContent = "\u64AD\u653E\u5730\u5740\u5DF2\u5C31\u7EEA\uFF0C\u8BF7\u70B9\u51FB\u64AD\u653E\u5668\u64AD\u653E";
        });
      } catch (error) {
        if (requestId !== this.audioRequestId) return;
        this.status.textContent = error instanceof Error ? `\u64AD\u653E\u5730\u5740\u83B7\u53D6\u5931\u8D25\uFF1A${error.message}` : "\u64AD\u653E\u5730\u5740\u83B7\u53D6\u5931\u8D25";
      }
    }
    closePlayer() {
      this.audioRequestId += 1;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.player.classList.add("abe-hidden");
    }
    async restoreState() {
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
          this.status.textContent = `\u5DF2\u6062\u590D ${this.entries.length} \u9879\uFF0C\u6309\u9700\u5C55\u5F00\u76EE\u5F55`;
        } else this.favorites = readLegacyFavorites();
        this.render();
        await this.requestPersistentStorage();
      } catch (error) {
        this.status.textContent = error instanceof Error ? `\u6062\u590D\u5931\u8D25\uFF1A${error.message}` : "\u6062\u590D\u5931\u8D25";
      }
    }
    async requestPersistentStorage() {
      if (!navigator.storage?.persist) return;
      try {
        const persisted = await navigator.storage.persist();
        if (persisted) this.status.textContent = "\u7D22\u5F15\u5DF2\u6062\u590D\uFF1B\u6D4F\u89C8\u5668\u5DF2\u542F\u7528\u6301\u4E45\u5316\u5B58\u50A8";
      } catch {
      }
    }
    async persistState(rootPath) {
      await saveIndexState({ id: location.origin, rootPath, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), entries: this.entries, favorites: [...this.favorites], blacklisted: [...this.blacklisted], failures: this.failures, loadedDirectories: [...this.loadedDirectories], directoryPagination: Object.fromEntries(this.directoryPagination), directoryLoadedAt: Object.fromEntries(this.directoryLoadedAt), seenUrls: [...this.seenUrls], directoryErrors: Object.fromEntries(this.directoryErrors), expandedDirectories: [...this.expandedDirectories], graph: serializeGraph(this.graph) });
    }
    exportIndex() {
      downloadJson(createIndexExport({ sourceOrigin: location.origin, rootPath: currentPath(), entries: this.entries, favorites: this.favorites, blacklisted: this.blacklisted, graph: serializeGraph(this.graph), desktopState: { seenUrls: [...this.seenUrls], loadedDirectories: [...this.loadedDirectories], directoryPagination: Object.fromEntries(this.directoryPagination), directoryLoadedAt: Object.fromEntries(this.directoryLoadedAt), expandedDirectories: [...this.expandedDirectories] } }), `asmrgay-index-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`);
      this.status.textContent = `\u5DF2\u5BFC\u51FA ${this.entries.length} \u9879\u5DF2\u52A0\u8F7D\u7D22\u5F15`;
    }
    exportFavoritesJson() {
      downloadJson({ schemaVersion: 1, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), sourceOrigin: location.origin, favorites: [...this.favorites] }, `asmrgay-favorites-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`);
      this.status.textContent = `\u5DF2\u5BFC\u51FA ${this.favorites.size} \u4E2A\u6536\u85CF`;
    }
    exportFavoritesCsv() {
      const rows = [["url", "title", "type"], ...this.entries.filter((entry) => this.favorites.has(entry.url)).map((entry) => [entry.url, entry.title, entry.type])];
      const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
      downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `asmrgay-favorites-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`);
      this.status.textContent = `\u5DF2\u5BFC\u51FA ${this.favorites.size} \u4E2A\u6536\u85CF`;
    }
    async importIndex(event) {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) {
        this.status.textContent = "\u5BFC\u5165\u5931\u8D25\uFF1A\u6587\u4EF6\u8D85\u8FC7 20 MB";
        return;
      }
      try {
        const imported = parseIndexExport(JSON.parse(await file.text()), location.origin);
        const mode = this.requireElement(".abe-import-mode").value;
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
          this.favorites = /* @__PURE__ */ new Set([...this.favorites, ...imported.favorites]);
          this.blacklisted = /* @__PURE__ */ new Set([...this.blacklisted, ...imported.blacklisted]);
        }
        if (imported.desktopState) {
          this.seenUrls = new Set(imported.desktopState.seenUrls);
          this.loadedDirectories = new Set(imported.desktopState.loadedDirectories);
          this.directoryPagination = new Map(Object.entries(imported.desktopState.directoryPagination));
          this.directoryLoadedAt = new Map(Object.entries(imported.desktopState.directoryLoadedAt));
          this.expandedDirectories = new Set(imported.desktopState.expandedDirectories ?? []);
        }
        await this.persistState(imported.rootPath);
        this.status.textContent = `${mode === "replace" ? "\u66FF\u6362" : "\u5408\u5E76"}\u5BFC\u5165\u5B8C\u6210\uFF1A\u5F53\u524D\u5171 ${this.entries.length} \u9879`;
        this.render();
      } catch (error) {
        this.status.textContent = error instanceof Error ? `\u5BFC\u5165\u5931\u8D25\uFF1A${error.message}` : "\u5BFC\u5165\u5931\u8D25";
      }
    }
    exportFailures() {
      if (!this.failures.length) {
        this.status.textContent = "\u76EE\u524D\u6CA1\u6709\u5931\u8D25\u8BB0\u5F55";
        return;
      }
      downloadJson({ schemaVersion: 1, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), sourceOrigin: location.origin, scannerMode: "alist-api", failures: this.failures }, `asmrgay-failures-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`);
    }
    async clearIndex() {
      if (!window.confirm("\u786E\u5B9A\u6E05\u7A7A\u5DF2\u52A0\u8F7D\u7D22\u5F15\u3001\u6536\u85CF\u548C\u9ED1\u540D\u5355\u5417\uFF1F\u5EFA\u8BAE\u5148\u5BFC\u51FA\u5907\u4EFD\u3002")) return;
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
      await deleteIndexState(location.origin);
      this.status.textContent = "\u7D22\u5F15\u3001\u6536\u85CF\u548C\u9ED1\u540D\u5355\u5DF2\u6E05\u7A7A";
      this.render();
    }
    setRefreshDisabled(disabled) {
      this.requireElement(".abe-refresh").disabled = disabled;
    }
    updatePath() {
      this.pathLabel.textContent = this.selectedDirectory;
    }
    requireElement(selector) {
      const element = this.root.querySelector(selector);
      if (!element) throw new Error(`Missing panel element: ${selector}`);
      return element;
    }
  };
  function normalizePath(path) {
    try {
      const decoded = decodeURIComponent(path);
      return decoded.startsWith("/") ? decoded : `/${decoded}`;
    } catch {
      return path.startsWith("/") ? path : `/${path}`;
    }
  }
  function pathFromUrl(url) {
    return normalizePath(new URL(url).pathname);
  }
  function encodePath(path) {
    return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  }
  function currentPath() {
    return normalizePath(location.pathname);
  }
  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  function mergeGraphs(left, right) {
    for (const [id, node] of right.nodes) left.nodes.set(id, node);
    for (const [id, edge] of right.edges) left.edges.set(id, edge);
    return left;
  }
  function nodeToEntry(node) {
    return { url: node.url, title: node.title, type: node.type, metadata: { ...node.metadata, status: node.status, discoveredAt: node.discoveredAt, lastSeenAt: node.lastSeenAt } };
  }
  function readLegacyFavorites() {
    try {
      const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
      return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }
  function typeEmptyMessage(type, hasEntries) {
    if (type === "blacklisted") return "\u9ED1\u540D\u5355\u4E3A\u7A7A";
    return hasEntries ? "\u6CA1\u6709\u5339\u914D\u6761\u76EE" : "\u5C55\u5F00\u76EE\u5F55\u540E\u5EFA\u7ACB\u7D22\u5F15";
  }
  async function resolveMediaUrl(fileUrl, sourceOrigin) {
    const path = decodeURIComponent(new URL(fileUrl).pathname);
    const response = await fetch(`${sourceOrigin}/api/fs/get`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, password: "" }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== 200 || !payload.data?.raw_url) throw new Error(payload.message || "\u63A5\u53E3\u672A\u8FD4\u56DE\u97F3\u9891\u5730\u5740");
    return payload.data.raw_url;
  }
  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }
  function formatTime(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "";
  }
  function csvCell(value) {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function downloadJson(value, filename) {
    downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" }), filename);
  }
  if (!document.querySelector("#asmrgay-browser-enhancer")) new OnDemandPanel();
})();
