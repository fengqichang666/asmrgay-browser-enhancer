import type { IndexGraph, IndexNode, NodeType } from "./graph.js";

export interface QueryOptions {
  text?: string;
  type?: NodeType | "all";
  includeMissing?: boolean;
}

export function queryNodes(
  graph: IndexGraph,
  options: QueryOptions = {},
): IndexNode[] {
  const text = options.text?.trim().toLocaleLowerCase();
  return [...graph.nodes.values()]
    .filter((node) => options.includeMissing || node.status === "active")
    .filter((node) => !options.type || options.type === "all" || node.type === options.type)
    .filter((node) => !text || `${node.title} ${node.url}`.toLocaleLowerCase().includes(text))
    .sort((a, b) => a.title.localeCompare(b.title, "zh-Hans") || a.url.localeCompare(b.url));
}
