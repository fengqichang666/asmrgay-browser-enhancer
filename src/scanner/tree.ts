import type { DiscoveredEntry } from "../core/graph.js";
import { scanAListDirectory, type FailureRecord, type ScanDirectoryOptions, type ScanDirectoryResult } from "./alist.js";

export type TreeScanState = "running" | "paused" | "stopped" | "completed";

export interface TreeScanProgress {
  state: TreeScanState;
  currentPath: string;
  directoriesScanned: number;
  directoriesQueued: number;
  entriesDiscovered: number;
  maxDepth: number;
}

export interface TreeScanResult {
  entries: DiscoveredEntry[];
  directoriesScanned: number;
  truncated: boolean;
  stopped: boolean;
  failures: FailureRecord[];
  checkpoint?: TreeScanCheckpoint;
}

export interface TreeScanCheckpoint {
  rootPath: string;
  maxDepth: number;
  maxNodes: number;
  maxDirectories: number;
  frontier: FrontierEntry[];
  visitedDirectories: string[];
  entries: DiscoveredEntry[];
  failures: FailureRecord[];
  directoriesScanned: number;
  updatedAt: string;
}

export interface TreeScanOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxDirectories?: number;
  directoryOptions?: Omit<ScanDirectoryOptions, "signal" | "onProgress">;
  scanDirectory?: (
    path: string,
    options: ScanDirectoryOptions,
  ) => Promise<ScanDirectoryResult>;
  onEntries?: (entries: readonly DiscoveredEntry[]) => void;
  onDirectoryScanned?: (path: string, entries: readonly DiscoveredEntry[]) => void;
  onProgress?: (progress: TreeScanProgress) => void;
  onCheckpoint?: (checkpoint: TreeScanCheckpoint) => void | Promise<void>;
  resumeFrom?: TreeScanCheckpoint;
}

export interface FrontierEntry {
  path: string;
  depth: number;
}

export class TreeScanController {
  private readonly abortController = new AbortController();
  private paused = false;
  private stopped = false;
  private resumeWaiters: Array<() => void> = [];

  pause(): void {
    if (!this.stopped) this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const resolve of this.resumeWaiters.splice(0)) resolve();
  }

  stop(): void {
    this.stopped = true;
    this.resume();
    this.abortController.abort(new DOMException("扫描已停止", "AbortError"));
  }

  async run(rootPath: string, options: TreeScanOptions = {}): Promise<TreeScanResult> {
    const maxDepth = clampInteger(options.maxDepth ?? 1, 1, 10);
    const maxNodes = clampInteger(options.maxNodes ?? 2_000, 1, 20_000);
    const maxDirectories = clampInteger(options.maxDirectories ?? 100, 1, 2_000);
    const scanDirectory = options.scanDirectory ?? scanAListDirectory;
    const resume = options.resumeFrom;
    const frontier: FrontierEntry[] = resume ? [...resume.frontier] : [{ path: normalizePath(rootPath), depth: 0 }];
    const visitedDirectories = new Set(resume?.visitedDirectories ?? []);
  const entries = new Map((resume?.entries ?? []).map((entry) => [entry.url, entry]));
    const failures: FailureRecord[] = [...(resume?.failures ?? [])];
    let directoriesScanned = resume?.directoriesScanned ?? 0;
    let consecutiveDirectoryFailures = 0;
    let truncated = false;

    while (frontier.length > 0 && !this.stopped) {
      await this.waitWhilePaused();
      if (this.stopped) break;
      if (directoriesScanned >= maxDirectories || entries.size >= maxNodes) {
        truncated = true;
        break;
      }

      const current = frontier.shift();
      if (!current || visitedDirectories.has(current.path)) continue;
      visitedDirectories.add(current.path);
      this.emitProgress(options, "running", current.path, directoriesScanned, frontier.length, entries.size, maxDepth);

      let result: ScanDirectoryResult;
      try {
        result = await scanDirectory(current.path, {
          ...options.directoryOptions,
          signal: this.abortController.signal,
          onFailure: (failure) => failures.push(failure),
        });
      } catch (error) {
        if (this.stopped || isAbortError(error)) {
          visitedDirectories.delete(current.path);
          frontier.unshift(current);
          break;
        }
        consecutiveDirectoryFailures += 1;
        failures.push({
          path: current.path,
          kind: "permanent",
          message: error instanceof Error ? error.message : "目录扫描失败",
          attempts: 1,
          occurredAt: new Date().toISOString(),
        });
        directoriesScanned += 1;
        await this.emitCheckpoint(options, rootPath, maxDepth, maxNodes, maxDirectories, frontier, visitedDirectories, entries, failures, directoriesScanned);
        if (consecutiveDirectoryFailures >= (options.directoryOptions?.circuitBreakerFailures ?? 5)) {
          truncated = true;
          break;
        }
        continue;
      }
      consecutiveDirectoryFailures = 0;
      directoriesScanned += 1;
      truncated ||= result.truncated;

      const batch: DiscoveredEntry[] = [];
      for (const entry of result.entries) {
        if (entries.size >= maxNodes) {
          truncated = true;
          break;
        }
        const enriched: DiscoveredEntry = {
          ...entry,
          metadata: {
            ...entry.metadata,
            depth: current.depth + 1,
            parentPath: current.path,
            scanRootPath: normalizePath(rootPath),
          },
        };
        if (!entries.has(entry.url)) batch.push(enriched);
        entries.set(entry.url, enriched);

        if (entry.type === "directory" && current.depth + 1 < maxDepth) {
          const childPath = pathFromUrl(entry.url);
          if (!visitedDirectories.has(childPath)) {
            frontier.push({ path: childPath, depth: current.depth + 1 });
          }
        }
      }
      if (batch.length > 0) options.onEntries?.(batch);
      options.onDirectoryScanned?.(current.path, result.entries.map((entry) => ({
        ...entry,
        metadata: {
          ...entry.metadata,
          depth: current.depth + 1,
          parentPath: current.path,
          scanRootPath: normalizePath(rootPath),
        },
      })));
      await this.emitCheckpoint(options, rootPath, maxDepth, maxNodes, maxDirectories, frontier, visitedDirectories, entries, failures, directoriesScanned);
      this.emitProgress(options, this.paused ? "paused" : "running", current.path, directoriesScanned, frontier.length, entries.size, maxDepth);
    }

    const state: TreeScanState = this.stopped ? "stopped" : "completed";
    this.emitProgress(options, state, "", directoriesScanned, frontier.length, entries.size, maxDepth);
    const checkpoint = frontier.length > 0 ? this.createCheckpoint(rootPath, maxDepth, maxNodes, maxDirectories, frontier, visitedDirectories, entries, failures, directoriesScanned) : undefined;
    return {
      entries: [...entries.values()],
      directoriesScanned,
      truncated,
      stopped: this.stopped,
      failures,
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  private async emitCheckpoint(
    options: TreeScanOptions,
    rootPath: string,
    maxDepth: number,
    maxNodes: number,
    maxDirectories: number,
    frontier: readonly FrontierEntry[],
    visitedDirectories: ReadonlySet<string>,
    entries: ReadonlyMap<string, DiscoveredEntry>,
    failures: readonly FailureRecord[],
    directoriesScanned: number,
  ): Promise<void> {
    if (!options.onCheckpoint) return;
    await options.onCheckpoint(this.createCheckpoint(rootPath, maxDepth, maxNodes, maxDirectories, frontier, visitedDirectories, entries, failures, directoriesScanned));
  }

  private createCheckpoint(
    rootPath: string,
    maxDepth: number,
    maxNodes: number,
    maxDirectories: number,
    frontier: readonly FrontierEntry[],
    visitedDirectories: ReadonlySet<string>,
    entries: ReadonlyMap<string, DiscoveredEntry>,
    failures: readonly FailureRecord[],
    directoriesScanned: number,
  ): TreeScanCheckpoint {
    return {
      rootPath: normalizePath(rootPath),
      maxDepth,
      maxNodes,
      maxDirectories,
      frontier: [...frontier],
      visitedDirectories: [...visitedDirectories],
      entries: [...entries.values()],
      failures: [...failures],
      directoriesScanned,
      updatedAt: new Date().toISOString(),
    };
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.paused || this.stopped) return;
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  private emitProgress(
    options: TreeScanOptions,
    state: TreeScanState,
    currentPath: string,
    directoriesScanned: number,
    directoriesQueued: number,
    entriesDiscovered: number,
    maxDepth: number,
  ): void {
    options.onProgress?.({
      state,
      currentPath,
      directoriesScanned,
      directoriesQueued,
      entriesDiscovered,
      maxDepth,
    });
  }
}

function pathFromUrl(url: string): string {
  return normalizePath(new URL(url).pathname);
}

function normalizePath(path: string): string {
  try {
    const decoded = decodeURIComponent(path);
    return decoded.startsWith("/") ? decoded : `/${decoded}`;
  } catch {
    return path.startsWith("/") ? path : `/${path}`;
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
