import { normalizeUrl } from "./url.js";

export type NodeType = "directory" | "content";
export type NodeStatus = "active" | "missing";

export interface IndexNode {
  id: string;
  url: string;
  title: string;
  type: NodeType;
  status: NodeStatus;
  discoveredAt: string;
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

export interface IndexEdge {
  id: string;
  parentId: string;
  childId: string;
  sourceUrl: string;
  label: string;
  position: number;
}

export interface DiscoveredEntry {
  url: string;
  title: string;
  type: NodeType;
  metadata?: Record<string, unknown>;
}

export interface IndexGraph {
  nodes: Map<string, IndexNode>;
  edges: Map<string, IndexEdge>;
}

export function createGraph(): IndexGraph {
  return { nodes: new Map(), edges: new Map() };
}

export function mergeEntries(
  graph: IndexGraph,
  parentUrl: string,
  entries: readonly DiscoveredEntry[],
  now = new Date().toISOString(),
  replaceParentEdges = true,
): void {
  const parentId = normalizeUrl(parentUrl);
  const existingParent = graph.nodes.get(parentId);
  ensureNode(graph, {
    url: parentId,
    title: existingParent?.title ?? titleFromUrl(parentId),
    type: "directory",
    metadata: {
      ...existingParent?.metadata,
      internalParent: existingParent === undefined || existingParent.metadata?.internalParent === true,
    },
  }, now);
  if (replaceParentEdges) {
    for (const [edgeId, edge] of graph.edges) {
      if (edge.parentId === parentId) graph.edges.delete(edgeId);
    }
  }

  const positionOffset = replaceParentEdges ? 0 : [...graph.edges.values()]
    .filter((edge) => edge.parentId === parentId)
    .reduce((max, edge) => Math.max(max, edge.position + 1), 0);
  entries.forEach((entry, position) => {
    const childId = normalizeUrl(entry.url, parentId);
    ensureNode(graph, {
      ...entry,
      url: childId,
      metadata: { ...entry.metadata, internalParent: false },
    }, now);
    const edgeId = `${parentId}\0${childId}\0${replaceParentEdges ? position : graph.edges.size}`;
    graph.edges.set(edgeId, {
      id: edgeId,
      parentId,
      childId,
      sourceUrl: parentId,
      label: entry.title,
      position: positionOffset + position,
    });
  });
}

function ensureNode(
  graph: IndexGraph,
  entry: DiscoveredEntry,
  now: string,
): void {
  const id = normalizeUrl(entry.url);
  const existing = graph.nodes.get(id);
  const node: IndexNode = {
    id,
    url: id,
    title: entry.title,
    type: entry.type,
    status: "active",
    discoveredAt: existing?.discoveredAt ?? now,
    lastSeenAt: now,
  };
  if (entry.metadata !== undefined || existing?.metadata !== undefined) {
    node.metadata = { ...existing?.metadata, ...entry.metadata };
  }
  graph.nodes.set(id, node);
}

export interface SerializedGraph {
  nodes: IndexNode[];
  edges: IndexEdge[];
}

export function serializeGraph(graph: IndexGraph): SerializedGraph {
  return { nodes: [...graph.nodes.values()], edges: [...graph.edges.values()] };
}

export function hydrateGraph(value?: Partial<SerializedGraph>): IndexGraph {
  const graph = {
    nodes: new Map((value?.nodes ?? []).map((node) => [node.id, node])),
    edges: new Map((value?.edges ?? []).map((edge) => [edge.id, edge])),
  };
  repairGraphDisplayMetadata(graph);
  return graph;
}

export function repairGraphDisplayMetadata(graph: IndexGraph): void {
  const labelsByChild = new Map<string, string>();
  const parentIds = new Set<string>();
  for (const edge of graph.edges.values()) {
    parentIds.add(edge.parentId);
    if (!labelsByChild.has(edge.childId)) labelsByChild.set(edge.childId, edge.label);
  }
  for (const node of graph.nodes.values()) {
    const label = labelsByChild.get(node.id);
    if (label) node.title = label;
    node.metadata = {
      ...node.metadata,
      internalParent: parentIds.has(node.id) && !labelsByChild.has(node.id),
    };
  }
}

export function graphEntries(graph: IndexGraph): DiscoveredEntry[] {
  return [...graph.nodes.values()]
    .filter((node) => node.metadata?.internalParent !== true)
    .map((node) => ({
    url: node.url,
    title: node.title,
    type: node.type,
    metadata: {
      ...node.metadata,
      status: node.status,
      discoveredAt: node.discoveredAt,
      lastSeenAt: node.lastSeenAt,
    },
    }));
}

function titleFromUrl(value: string): string {
  const url = new URL(value);
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return "/";
  try { return decodeURIComponent(segment); } catch { return segment; }
}

export function markScopedNodesMissing(
  graph: IndexGraph,
  scanRootPath: string,
  maxDepth: number,
  observedUrls: ReadonlySet<string>,
): void {
  for (const node of graph.nodes.values()) {
    const depth = node.metadata?.depth;
    if (
      node.metadata?.scanRootPath === scanRootPath &&
      typeof depth === "number" &&
      depth <= maxDepth &&
      !observedUrls.has(node.url)
    ) node.status = "missing";
  }
}

export function markUnseenMissing(
  graph: IndexGraph,
  observedUrls: ReadonlySet<string>,
): void {
  for (const node of graph.nodes.values()) {
    if (!observedUrls.has(node.id)) node.status = "missing";
  }
}

export function directChildren(graph: IndexGraph, parentUrl: string): Set<string> {
  const parentId = normalizeUrl(parentUrl);
  return new Set([...graph.edges.values()]
    .filter((edge) => edge.parentId === parentId)
    .map((edge) => edge.childId));
}

export function reconcileDirectoryChildren(
  graph: IndexGraph,
  previousChildIds: ReadonlySet<string>,
  observedChildIds: ReadonlySet<string>,
  lastSeenAt = new Date().toISOString(),
): void {
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

export function childrenOf(graph: IndexGraph, parentUrl: string): IndexNode[] {
  const parentId = normalizeUrl(parentUrl);
  const edges = [...graph.edges.values()]
    .filter((edge) => edge.parentId === parentId)
    .sort((left, right) => left.position - right.position);
  const seen = new Set<string>();
  const children: IndexNode[] = [];
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

export function setNodeType(graph: IndexGraph, url: string, type: NodeType): void {
  const node = graph.nodes.get(normalizeUrl(url));
  if (node) {
    node.type = type;
    node.metadata = { ...node.metadata, manuallyClassified: true };
  }
}
