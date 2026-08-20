import { describe, expect, it } from "vitest";
import { createGraph, mergeEntries } from "../../src/core/graph.js";
import { queryNodes } from "../../src/core/query.js";

describe("desktop index performance", () => {
  it("searches a 10,000-node index within the desktop target", () => {
    const graph = createGraph();
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      url: `https://www.asmrgay.com/library/item-${index}.mp3`,
      title: index === 9_999 ? "target audio" : `audio ${index}`,
      type: "content" as const,
    }));
    mergeEntries(graph, "https://www.asmrgay.com/library", entries);
    const startedAt = performance.now();
    const results = queryNodes(graph, { text: "target audio" });
    const elapsed = performance.now() - startedAt;
    expect(results).toHaveLength(1);
    expect(elapsed).toBeLessThan(100);
  });
});
