import { classifyEntry } from "../core/classify.js";
import type { DiscoveredEntry } from "../core/graph.js";
import { normalizeUrl } from "../core/url.js";

interface AListItem { name: string; size: number; is_dir: boolean; modified: string; type: number; }
interface AListListResponse { code: number; message: string; data?: { content: AListItem[] | null; total: number }; }

export interface ScanProgress { loaded: number; total: number; page: number; }
export interface FailureRecord { path: string; status?: number; kind: "network" | "429" | "5xx" | "permanent" | "invalid-response"; message: string; attempts: number; retryAfterMs?: number; occurredAt: string; }
export interface ScanDirectoryOptions { pageSize?: number; startPage?: number; maxPages?: number; delayMs?: number; jitterMs?: number; maxRetries?: number; backoffBaseMs?: number; backoffCapMs?: number; circuitBreakerFailures?: number; signal?: AbortSignal; onProgress?: (progress: ScanProgress) => void; onFailure?: (failure: FailureRecord) => void; }
export interface ScanDirectoryResult { path: string; entries: DiscoveredEntry[]; total: number; truncated: boolean; failures: FailureRecord[]; startPage: number; pagesLoaded: number; }

export async function scanAListDirectory(path: string, options: ScanDirectoryOptions = {}): Promise<ScanDirectoryResult> {
  const pageSize = options.pageSize ?? 100;
  const startPage = options.startPage ?? 1;
  const maxPages = options.maxPages ?? 20;
  const entries: DiscoveredEntry[] = [];
  const failures: FailureRecord[] = [];
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

async function requestPage(path: string, page: number, pageSize: number, options: ScanDirectoryOptions, onFailure: (failure: FailureRecord) => void): Promise<AListListResponse> {
  const maxRetries = options.maxRetries ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const init: RequestInit = { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, password: "", page, per_page: pageSize, refresh: false }) };
      if (options.signal) init.signal = options.signal;
      const response = await fetch("/api/fs/list", init);
      const contentType = response.headers.get("Content-Type") ?? "";
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      if (response.ok && contentType.toLowerCase().includes("application/json")) {
        const payload = await response.json() as AListListResponse;
        if (payload.code === 200 && payload.data) return payload;
        throw new Error(payload.message || `目录接口错误：${payload.code}`);
      }
      const responseText = contentType.toLowerCase().includes("application/json") ? "" : await response.text();
      const cloudflare1015 = /Error\s*1015|being rate limited/i.test(responseText);
      const transient = response.status === 429 || response.status >= 500;
      const kind: FailureRecord["kind"] = cloudflare1015 || response.status === 429 ? "429" : response.status >= 500 ? "5xx" : contentType.toLowerCase().includes("json") ? "invalid-response" : "permanent";
      const message = cloudflare1015
        ? "Cloudflare 1015：当前网络已被临时限流，请停止请求并稍后再试"
        : response.ok ? `目录接口返回非 JSON 内容：${contentType || "未知类型"}` : transient ? `HTTP ${response.status}` : `目录接口返回 ${contentType || "未知类型"}`;
      const failure: FailureRecord = { path, status: response.status, kind, message, attempts: attempt, occurredAt: new Date().toISOString() };
      if (retryAfterMs !== undefined) failure.retryAfterMs = retryAfterMs;
      onFailure(failure);
      if (!transient || attempt > maxRetries) throw new Error(failure.message);
      await waitWithJitter(retryAfterMs ?? Math.min(options.backoffCapMs ?? 30_000, (options.backoffBaseMs ?? 1_000) * 2 ** (attempt - 1)), options.jitterMs ?? 500, options.signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      if (error instanceof Error && (/^目录接口返回/.test(error.message) || /^目录接口错误/.test(error.message) || /^Cloudflare 1015/.test(error.message))) throw error;
      if (error instanceof Error && /HTTP 429|HTTP 5\d\d/.test(error.message) && attempt <= maxRetries) continue;
      if (attempt > maxRetries) break;
      const failure: FailureRecord = { path, kind: "network", message: error instanceof Error ? error.message : "网络请求失败", attempts: attempt, occurredAt: new Date().toISOString() };
      onFailure(failure);
      await waitWithJitter(Math.min(options.backoffCapMs ?? 30_000, (options.backoffBaseMs ?? 1_000) * 2 ** (attempt - 1)), options.jitterMs ?? 500, options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("目录请求失败");
}

function toDiscoveredEntry(path: string, item: AListItem): DiscoveredEntry { return { url: normalizeUrl(buildItemUrl(path, item.name)), title: item.name, type: classifyEntry({ isDirectory: item.is_dir, name: item.name }), metadata: { size: item.size, modified: item.modified, alistType: item.type } }; }
function buildItemUrl(path: string, name: string): URL { const origin = typeof location === "undefined" ? "https://www.asmrgay.com" : location.origin; return new URL(`${path.endsWith("/") ? path : `${path}/`}${encodeURIComponent(name)}`, origin); }
function parseRetryAfter(value: string | null): number | undefined { if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000); const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined; }
async function waitWithJitter(delayMs: number, jitterMs: number, signal?: AbortSignal): Promise<void> { const duration = delayMs + Math.floor(Math.random() * (jitterMs + 1)); await new Promise<void>((resolve, reject) => { const timeout = setTimeout(resolve, duration); signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(signal.reason); }, { once: true }); }); }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
