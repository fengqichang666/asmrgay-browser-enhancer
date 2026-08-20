import { describe, expect, it, vi } from "vitest";
import type { DiscoveredEntry } from "../../src/core/graph.js";
import type { ScanDirectoryResult } from "../../src/scanner/alist.js";
import { TreeScanController } from "../../src/scanner/tree.js";

function result(path: string, entries: DiscoveredEntry[]): ScanDirectoryResult {
  return { path, entries, total: entries.length, truncated: false, failures: [], startPage: 1, pagesLoaded: 1 };
}

describe("TreeScanController", () => {
  it("scans breadth-first up to the selected depth", async () => {
    const scanDirectory = vi.fn(async (path: string) => {
      if (path === "/") return result(path, [
        { url: "https://www.asmrgay.com/a", title: "A", type: "directory" },
        { url: "https://www.asmrgay.com/root.mp3", title: "root", type: "content" },
      ]);
      return result(path, [
        { url: "https://www.asmrgay.com/a/child.mp3", title: "child", type: "content" },
      ]);
    });
    const controller = new TreeScanController();
    const tree = await controller.run("/", { maxDepth: 2, scanDirectory });
    expect(scanDirectory.mock.calls.map(([path]) => path)).toEqual(["/", "/a"]);
    expect(tree.entries.map((entry) => entry.title)).toEqual(["A", "root", "child"]);
  });

  it("does not enter child directories at depth one", async () => {
    const scanDirectory = vi.fn(async (path: string) => result(path, [
      { url: "https://www.asmrgay.com/a", title: "A", type: "directory" },
    ]));
    const tree = await new TreeScanController().run("/", { maxDepth: 1, scanDirectory });
    expect(scanDirectory).toHaveBeenCalledTimes(1);
    expect(tree.stopped).toBe(false);
  });

  it("stops at the node safety limit", async () => {
    const scanDirectory = vi.fn(async (path: string) => result(path, [
      { url: "https://www.asmrgay.com/a", title: "A", type: "content" },
      { url: "https://www.asmrgay.com/b", title: "B", type: "content" },
      { url: "https://www.asmrgay.com/c", title: "C", type: "content" },
    ]));
    const tree = await new TreeScanController().run("/", { maxNodes: 2, scanDirectory });
    expect(tree.entries).toHaveLength(2);
    expect(tree.truncated).toBe(true);
  });

  it("can pause before the next directory and resume", async () => {
    const scanned: string[] = [];
    const controller = new TreeScanController();
    const scanDirectory = vi.fn(async (path: string) => {
      scanned.push(path);
      if (path === "/") {
        controller.pause();
        return result(path, [{ url: "https://www.asmrgay.com/a", title: "A", type: "directory" }]);
      }
      return result(path, []);
    });
    const running = controller.run("/", { maxDepth: 2, scanDirectory });
    await vi.waitFor(() => expect(scanned).toEqual(["/"]));
    controller.resume();
    await running;
    expect(scanned).toEqual(["/", "/a"]);
  });

  it("emits a checkpoint that can resume the remaining frontier", async () => {
    const checkpoints = [] as import("../../src/scanner/tree.js").TreeScanCheckpoint[];
    const scanDirectory = vi.fn(async (path: string) => result(path, path === "/"
      ? [{ url: "https://www.asmrgay.com/a", title: "A", type: "directory" }, { url: "https://www.asmrgay.com/b", title: "B", type: "directory" }]
      : []));
    const first = await new TreeScanController().run("/", { maxDepth: 2, maxDirectories: 1, scanDirectory, onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); } });
    expect(first.checkpoint?.frontier.map((item) => item.path)).toEqual(["/a", "/b"]);
    const resumed = await new TreeScanController().run("/", { maxDepth: 2, scanDirectory, resumeFrom: first.checkpoint! });
    expect(resumed.directoriesScanned).toBe(3);
  });
});
