import type { DiscoveredEntry, NodeType, SerializedGraph } from "./graph.js";
import { normalizeUrl } from "./url.js";

export const INDEX_SCHEMA_VERSION = 1;
export const MAX_IMPORT_ENTRIES = 20_000;

export interface IndexExport {
  schemaVersion: 1;
  exportedAt: string;
  sourceOrigin: string;
  scannerMode: "alist-api";
  rootPath: string;
  entries: DiscoveredEntry[];
  favorites: string[];
  blacklisted: string[];
  graph?: SerializedGraph;
  desktopState?: DesktopExportState;
}

export interface DesktopExportState {
  seenUrls: string[];
  loadedDirectories: string[];
  directoryPagination: Record<string, { nextPage: number; loaded: number; total: number; complete: boolean }>;
  directoryLoadedAt: Record<string, string>;
  expandedDirectories?: string[];
}

export interface CreateExportInput {
  sourceOrigin: string;
  rootPath: string;
  entries: readonly DiscoveredEntry[];
  favorites: ReadonlySet<string>;
  blacklisted?: ReadonlySet<string>;
  exportedAt?: string;
  graph?: SerializedGraph;
  desktopState?: DesktopExportState;
}

export function createIndexExport(input: CreateExportInput): IndexExport {
  const sourceOrigin = normalizeOrigin(input.sourceOrigin);
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    sourceOrigin,
    scannerMode: "alist-api",
    rootPath: normalizeRootPath(input.rootPath),
    entries: input.entries.map((entry) => sanitizeEntry(entry, sourceOrigin)),
    favorites: [...input.favorites].map((url) => normalizeSameOriginUrl(url, sourceOrigin)),
    blacklisted: [...(input.blacklisted ?? [])].map((url) => normalizeSameOriginUrl(url, sourceOrigin)),
    ...(input.graph ? { graph: input.graph } : {}),
    ...(input.desktopState ? { desktopState: sanitizeDesktopState(input.desktopState, sourceOrigin) } : {}),
  };
}

export function parseIndexExport(value: unknown, expectedOrigin: string): IndexExport {
  if (!isRecord(value)) throw new Error("导入文件必须是 JSON 对象");
  if (value.schemaVersion !== INDEX_SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion：${String(value.schemaVersion)}`);
  }
  if (value.scannerMode !== "alist-api") throw new Error("不支持的扫描器模式");
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    throw new Error("exportedAt 无效");
  }
  if (typeof value.sourceOrigin !== "string") throw new Error("sourceOrigin 缺失");
  const sourceOrigin = normalizeOrigin(value.sourceOrigin);
  if (sourceOrigin !== normalizeOrigin(expectedOrigin)) throw new Error("导入文件来源域与当前站点不一致");
  if (typeof value.rootPath !== "string") throw new Error("rootPath 无效");
  if (!Array.isArray(value.entries)) throw new Error("entries 必须是数组");
  if (value.entries.length > MAX_IMPORT_ENTRIES) throw new Error(`entries 超过 ${MAX_IMPORT_ENTRIES} 项上限`);
  if (!Array.isArray(value.favorites)) throw new Error("favorites 必须是数组");
  if (value.blacklisted !== undefined && !Array.isArray(value.blacklisted)) throw new Error("blacklisted 必须是数组");

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
      if (typeof url !== "string") throw new Error("favorites 含有非字符串地址");
      return normalizeSameOriginUrl(url, sourceOrigin);
    }),
    blacklisted: (value.blacklisted ?? []).map((url) => {
      if (typeof url !== "string") throw new Error("blacklisted 含有非字符串地址");
      return normalizeSameOriginUrl(url, sourceOrigin);
    }),
    ...(graph ? { graph } : {}),
    ...(desktopState ? { desktopState } : {}),
  };
}

function parseDesktopState(value: unknown, origin: string): DesktopExportState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.seenUrls) || !Array.isArray(value.loadedDirectories) || !isRecord(value.directoryPagination) || !isRecord(value.directoryLoadedAt)) throw new Error("desktopState 无效");
  const seenUrls = value.seenUrls.map((url) => { if (typeof url !== "string") throw new Error("seenUrls 无效"); return normalizeSameOriginUrl(url, origin); });
  const loadedDirectories = value.loadedDirectories.map((path) => { if (typeof path !== "string") throw new Error("loadedDirectories 无效"); return normalizeRootPath(path); });
  const directoryPagination: DesktopExportState["directoryPagination"] = {};
  for (const [path, state] of Object.entries(value.directoryPagination)) {
    if (!isRecord(state) || typeof state.nextPage !== "number" || typeof state.loaded !== "number" || typeof state.total !== "number" || typeof state.complete !== "boolean") throw new Error("directoryPagination 无效");
    directoryPagination[normalizeRootPath(path)] = { nextPage: state.nextPage, loaded: state.loaded, total: state.total, complete: state.complete };
  }
  const directoryLoadedAt: Record<string, string> = {};
  for (const [path, date] of Object.entries(value.directoryLoadedAt)) {
    if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) throw new Error("directoryLoadedAt 无效");
    directoryLoadedAt[normalizeRootPath(path)] = date;
  }
  const expandedDirectories = value.expandedDirectories === undefined ? undefined : !Array.isArray(value.expandedDirectories) ? (() => { throw new Error("expandedDirectories 无效"); })() : value.expandedDirectories.map((path: unknown) => {
    if (typeof path !== "string") throw new Error("expandedDirectories 无效");
    return normalizeRootPath(path);
  });
  return { seenUrls, loadedDirectories, directoryPagination, directoryLoadedAt, ...(expandedDirectories ? { expandedDirectories } : {}) };
}

function sanitizeDesktopState(value: DesktopExportState, origin: string): DesktopExportState {
  return parseDesktopState(value, origin)!;
}

function parseGraph(value: unknown, origin: string): SerializedGraph | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error("graph 无效");
  const nodes = value.nodes.map((node) => {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.url !== "string" || typeof node.title !== "string" || !isNodeType(node.type) || (node.status !== "active" && node.status !== "missing") || typeof node.discoveredAt !== "string" || typeof node.lastSeenAt !== "string") throw new Error("graph.nodes 含有无效节点");
    const url = normalizeSameOriginUrl(node.url, origin);
    if (node.id !== url) throw new Error("graph 节点 ID 与 URL 不一致");
    return node as unknown as SerializedGraph["nodes"][number];
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = value.edges.map((edge) => {
    if (!isRecord(edge) || typeof edge.id !== "string" || typeof edge.parentId !== "string" || typeof edge.childId !== "string" || typeof edge.sourceUrl !== "string" || typeof edge.label !== "string" || typeof edge.position !== "number") throw new Error("graph.edges 含有无效边");
    if (!nodeIds.has(edge.parentId) || !nodeIds.has(edge.childId)) throw new Error("graph 边引用了不存在的节点");
    normalizeSameOriginUrl(edge.sourceUrl, origin);
    return edge as unknown as SerializedGraph["edges"][number];
  });
  return { nodes, edges };
}

export function mergeEntryLists(
  current: readonly DiscoveredEntry[],
  incoming: readonly DiscoveredEntry[],
): DiscoveredEntry[] {
  const merged = new Map<string, DiscoveredEntry>();
  for (const entry of current) merged.set(entry.url, entry);
  for (const entry of incoming) merged.set(entry.url, entry);
  return [...merged.values()];
}

function parseEntry(value: unknown, origin: string): DiscoveredEntry {
  if (!isRecord(value)) throw new Error("entries 含有无效条目");
  if (typeof value.url !== "string") throw new Error("条目 URL 无效");
  if (typeof value.title !== "string" || value.title.length === 0 || value.title.length > 2_000) {
    throw new Error("条目标题无效");
  }
  if (!isNodeType(value.type)) throw new Error("条目类型无效");
  const entry: DiscoveredEntry = {
    url: normalizeSameOriginUrl(value.url, origin),
    title: value.title,
    type: value.type,
  };
  if (value.metadata !== undefined) {
    if (!isJsonRecord(value.metadata)) throw new Error("条目 metadata 无效");
    entry.metadata = value.metadata;
  }
  return entry;
}

function sanitizeEntry(entry: DiscoveredEntry, origin: string): DiscoveredEntry {
  return parseEntry(entry, origin);
}

function normalizeSameOriginUrl(value: string, origin: string): string {
  const normalized = normalizeUrl(value, origin);
  if (new URL(normalized).origin !== origin) throw new Error("索引中包含站外地址");
  return normalized;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("来源域协议无效");
  return url.origin;
}

function normalizeRootPath(value: string): string {
  if (!value.startsWith("/") || value.length > 4_000) throw new Error("rootPath 无效");
  return value;
}

function isNodeType(value: unknown): value is NodeType {
  return value === "directory" || value === "content";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
