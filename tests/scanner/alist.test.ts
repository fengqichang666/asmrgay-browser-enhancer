import { afterEach, describe, expect, it, vi } from "vitest";
import { scanAListDirectory } from "../../src/scanner/alist.js";

afterEach(() => vi.restoreAllMocks());

describe("scanAListDirectory", () => {
  it("reads paginated AList responses with omitted credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      const page = body.page;
      return new Response(JSON.stringify({
        code: 200,
        message: "success",
        data: {
          total: 3,
          content: page === 1
            ? [{ name: "目录", size: 0, is_dir: true, modified: "", type: 1 }, { name: "音频.mp3", size: 1000, is_dir: false, modified: "", type: 3 }]
            : [{ name: "说明.md", size: 30, is_dir: false, modified: "", type: 4 }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    });

    const result = await scanAListDirectory("/asmr", { pageSize: 2, delayMs: 0, jitterMs: 0 });
    expect(result.entries.map((entry) => entry.title)).toEqual(["目录", "音频.mp3", "说明.md"]);
    expect(result.truncated).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.startPage).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", method: "POST" });
  });

  it("rejects a successful HTTP response with a non-JSON content type", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>blocked</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    await expect(scanAListDirectory("/", { delayMs: 0, jitterMs: 0 }))
      .rejects.toThrow("非 JSON");
  });

  it("reports truncation when the page safety cap is reached", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 200, message: "success", data: { total: 999, content: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await scanAListDirectory("/", { maxPages: 1, delayMs: 0, jitterMs: 0 });
    expect(result.truncated).toBe(true);
  });

  it("retries 429 using Retry-After and then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
      return new Response(JSON.stringify({ code: 200, message: "success", data: { total: 0, content: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await scanAListDirectory("/", { maxRetries: 1, delayMs: 0, jitterMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.failures[0]?.kind).toBe("429");
  });

  it("does not retry permanent 404 responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404, headers: { "Content-Type": "text/plain" } }));
    await expect(scanAListDirectory("/", { maxRetries: 3, delayMs: 0, jitterMs: 0 })).rejects.toThrow("目录接口返回");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on a Cloudflare 1015 page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><title>Error 1015</title><p>You are being rate limited</p></html>",
      { status: 403, headers: { "Content-Type": "text/html" } },
    ));
    await expect(scanAListDirectory("/", { maxRetries: 3, delayMs: 0, jitterMs: 0 }))
      .rejects.toThrow("Cloudflare 1015");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports explicit page cursors for on-demand loading", async () => {
    const pages: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      pages.push(body.page);
      return new Response(JSON.stringify({
        code: 200,
        message: "success",
        data: {
          total: 250,
          content: [{ name: `item-${body.page}`, size: 1, is_dir: false, modified: "", type: 3 }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const first = await scanAListDirectory("/big", { pageSize: 100, startPage: 1, maxPages: 1, delayMs: 0, jitterMs: 0 });
    const second = await scanAListDirectory("/big", { pageSize: 100, startPage: 2, maxPages: 1, delayMs: 0, jitterMs: 0 });
    expect(pages).toEqual([1, 2]);
    expect(first.startPage).toBe(1);
    expect(second.startPage).toBe(2);
  });
});
