import { describe, expect, it } from "vitest";
import { childrenOf, createGraph, directChildren, graphEntries, hydrateGraph, markScopedNodesMissing, mergeEntries, markUnseenMissing, reconcileDirectoryChildren, serializeGraph, setNodeType } from "../../src/core/graph.js";
import { queryNodes } from "../../src/core/query.js";

describe("graph", () => {
  it("merges duplicate URLs while preserving positions and parents", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/", [
      { url: "/a", title: "A", type: "directory" },
      { url: "/same", title: "Same", type: "content" },
    ], "2026-01-01T00:00:00.000Z");
    mergeEntries(graph, "https://www.asmrgay.com/other", [
      { url: "/same", title: "Same", type: "content" },
    ], "2026-01-02T00:00:00.000Z");
    expect(graph.nodes.size).toBe(4);
    expect(graph.edges.size).toBe(3);
    expect([...graph.nodes.values()].find((n) => n.url.endsWith("/same"))?.lastSeenAt)
      .toBe("2026-01-02T00:00:00.000Z");
  });

  it("marks nodes absent from a rescan as missing and filters them by default", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/", [
      { url: "/kept", title: "Kept", type: "content" },
      { url: "/gone", title: "Gone", type: "content" },
    ]);
    markUnseenMissing(graph, new Set(["https://www.asmrgay.com/", "https://www.asmrgay.com/kept"]));
    expect(queryNodes(graph, { type: "content" }).map((n) => n.title)).toEqual(["Kept"]);
    expect(queryNodes(graph, { includeMissing: true }).map((n) => n.title)).toContain("Gone");
  });

  it("serializes and hydrates graph nodes and edges", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/", [
      { url: "/a", title: "A", type: "directory", metadata: { depth: 1, scanRootPath: "/" } },
    ]);
    const restored = hydrateGraph(serializeGraph(graph));
    expect(restored.nodes.size).toBe(graph.nodes.size);
    expect(restored.edges.size).toBe(graph.edges.size);
    expect(graphEntries(restored).some((entry) => entry.title === "A")).toBe(true);
  });

  it("marks only nodes in the rescanned scope as missing", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/", [
      { url: "/a", title: "A", type: "content", metadata: { depth: 1, scanRootPath: "/" } },
      { url: "/b", title: "B", type: "content", metadata: { depth: 1, scanRootPath: "/other" } },
    ]);
    markScopedNodesMissing(graph, "/", 1, new Set(["https://www.asmrgay.com/"]));
    expect(graph.nodes.get("https://www.asmrgay.com/a")?.status).toBe("missing");
    expect(graph.nodes.get("https://www.asmrgay.com/b")?.status).toBe("active");
  });

  it("hides internal parent nodes and preserves a discovered directory title", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/asmr", [
      { url: "/asmr/中文音声", title: "中文音声", type: "directory" },
    ]);
    mergeEntries(graph, "https://www.asmrgay.com/asmr/中文音声", [
      { url: "/asmr/中文音声/AD学姐", title: "AD学姐", type: "directory" },
    ]);
    mergeEntries(graph, "https://www.asmrgay.com/asmr/中文音声/AD学姐", []);

    const entries = graphEntries(graph);
    expect(entries.map((entry) => entry.title)).toEqual(["中文音声", "AD学姐"]);
    expect(entries.some((entry) => entry.title.startsWith("https://"))).toBe(false);
  });

  it("repairs legacy parent URL titles while hydrating cached graphs", () => {
    const restored = hydrateGraph({
      nodes: [
        { id: "https://www.asmrgay.com/asmr", url: "https://www.asmrgay.com/asmr", title: "https://www.asmrgay.com/asmr", type: "directory", status: "active", discoveredAt: "x", lastSeenAt: "x" },
        { id: "https://www.asmrgay.com/asmr/%E4%B8%AD%E6%96%87%E9%9F%B3%E5%A3%B0", url: "https://www.asmrgay.com/asmr/%E4%B8%AD%E6%96%87%E9%9F%B3%E5%A3%B0", title: "https://www.asmrgay.com/asmr/%E4%B8%AD%E6%96%87%E9%9F%B3%E5%A3%B0", type: "directory", status: "active", discoveredAt: "x", lastSeenAt: "x" },
      ],
      edges: [{ id: "edge", parentId: "https://www.asmrgay.com/asmr", childId: "https://www.asmrgay.com/asmr/%E4%B8%AD%E6%96%87%E9%9F%B3%E5%A3%B0", sourceUrl: "https://www.asmrgay.com/asmr", label: "中文音声", position: 0 }],
    });
    expect(graphEntries(restored).map((entry) => entry.title)).toEqual(["中文音声"]);
  });

  it("marks removed direct children missing only after a complete refresh", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/dir", [
      { url: "/dir/old.mp3", title: "old.mp3", type: "content" },
      { url: "/dir/keep.mp3", title: "keep.mp3", type: "content" },
    ]);
    const previous = directChildren(graph, "https://www.asmrgay.com/dir");
    mergeEntries(graph, "https://www.asmrgay.com/dir", [
      { url: "/dir/keep.mp3", title: "keep.mp3", type: "content" },
    ]);
    reconcileDirectoryChildren(graph, previous, directChildren(graph, "https://www.asmrgay.com/dir"), "2026-08-20T00:00:00.000Z");
    expect(graph.nodes.get("https://www.asmrgay.com/dir/old.mp3")?.status).toBe("missing");
    expect(graph.nodes.get("https://www.asmrgay.com/dir/keep.mp3")?.status).toBe("active");
  });

  it("returns source-order children and supports manual reclassification", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/dir", [
      { url: "/dir/a", title: "A", type: "content" },
      { url: "/dir/b", title: "B", type: "directory" },
    ]);
    expect(childrenOf(graph, "https://www.asmrgay.com/dir").map((node) => node.title)).toEqual(["A", "B"]);
    setNodeType(graph, "https://www.asmrgay.com/dir/a", "directory");
    expect(graph.nodes.get("https://www.asmrgay.com/dir/a")?.type).toBe("directory");
    expect(graph.nodes.get("https://www.asmrgay.com/dir/a")?.metadata?.manuallyClassified).toBe(true);
  });

  it("appends later pages after existing directory children", () => {
    const graph = createGraph();
    mergeEntries(graph, "https://www.asmrgay.com/dir", [
      { url: "/dir/a", title: "A", type: "content" },
      { url: "/dir/b", title: "B", type: "content" },
    ]);
    mergeEntries(graph, "https://www.asmrgay.com/dir", [
      { url: "/dir/c", title: "C", type: "content" },
      { url: "/dir/d", title: "D", type: "content" },
    ], "2026-08-20T00:00:00.000Z", false);
    expect(childrenOf(graph, "https://www.asmrgay.com/dir").map((node) => node.title)).toEqual(["A", "B", "C", "D"]);
  });
});
