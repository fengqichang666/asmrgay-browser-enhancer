import { describe, expect, it } from "vitest";
import { createIndexExport, mergeEntryLists, parseIndexExport } from "../../src/core/schema.js";

const origin = "https://www.asmrgay.com";

describe("index export schema", () => {
  it("round-trips a valid export", () => {
    const exported = createIndexExport({
      sourceOrigin: origin,
      rootPath: "/asmr",
      entries: [{ url: `${origin}/asmr/a.mp3`, title: "A", type: "content" }],
      favorites: new Set([`${origin}/asmr/a.mp3`]),
      blacklisted: new Set([`${origin}/asmr/skip`]),
      exportedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(parseIndexExport(exported, origin)).toEqual(exported);
  });

  it("rejects unknown versions and mismatched origins", () => {
    const exported = createIndexExport({ sourceOrigin: origin, rootPath: "/", entries: [], favorites: new Set() });
    expect(() => parseIndexExport({ ...exported, schemaVersion: 99 }, origin)).toThrow("schemaVersion");
    expect(() => parseIndexExport(exported, "https://example.com")).toThrow("来源域");
  });

  it("accepts legacy exports without a blacklist", () => {
    const exported = createIndexExport({ sourceOrigin: origin, rootPath: "/", entries: [], favorites: new Set() });
    const { blacklisted: _blacklisted, ...legacy } = exported;
    expect(parseIndexExport(legacy, origin).blacklisted).toEqual([]);
  });

  it("rejects external entry URLs", () => {
    const exported = createIndexExport({ sourceOrigin: origin, rootPath: "/", entries: [], favorites: new Set() });
    expect(() => parseIndexExport({
      ...exported,
      entries: [{ url: "https://evil.example/file", title: "bad", type: "content" }],
    }, origin)).toThrow("站外地址");
  });

  it("merges entries by normalized URL with incoming data winning", () => {
    const merged = mergeEntryLists(
      [{ url: `${origin}/a`, title: "old", type: "content" }],
      [{ url: `${origin}/a`, title: "new", type: "content" }, { url: `${origin}/b`, title: "B", type: "directory" }],
    );
    expect(merged.map((entry) => entry.title)).toEqual(["new", "B"]);
  });

  it("preserves graph data in the exported index", () => {
    const graph = { nodes: [], edges: [] };
    const exported = createIndexExport({ sourceOrigin: origin, rootPath: "/", entries: [], favorites: new Set(), graph });
    expect(parseIndexExport(exported, origin).graph).toEqual(graph);
  });

  it("round-trips desktop seen and pagination state", () => {
    const desktopState = {
      seenUrls: [`${origin}/a`],
      loadedDirectories: ["/asmr"],
      directoryPagination: { "/asmr": { nextPage: 2, loaded: 100, total: 311, complete: false } },
      directoryLoadedAt: { "/asmr": "2026-08-20T00:00:00.000Z" },
    };
    const exported = createIndexExport({ sourceOrigin: origin, rootPath: "/asmr", entries: [], favorites: new Set(), desktopState });
    expect(parseIndexExport(exported, origin).desktopState).toEqual(desktopState);
  });
});
