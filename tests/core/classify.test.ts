import { describe, expect, it } from "vitest";
import { classifyEntry } from "../../src/core/classify.js";

describe("classifyEntry", () => {
  it("uses directory signal first", () => {
    expect(classifyEntry({ isDirectory: true, name: "audio.mp3" })).toBe("directory");
  });
  it("classifies media extensions as content", () => {
    expect(classifyEntry({ isDirectory: false, name: "track.mp3" })).toBe("content");
  });
  it("uses child and pagination signals for ambiguous entries", () => {
    expect(classifyEntry({ isDirectory: false, name: "album", childCount: 2 })).toBe("directory");
    expect(classifyEntry({ isDirectory: false, name: "album", hasPagination: true })).toBe("directory");
  });
});
