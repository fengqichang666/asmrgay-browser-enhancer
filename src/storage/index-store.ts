import type { DiscoveredEntry, SerializedGraph } from "../core/graph.js";
import type { FailureRecord } from "../scanner/alist.js";
import type { TreeScanCheckpoint } from "../scanner/tree.js";

const DATABASE_NAME = "asmrgay-browser-enhancer";
const DATABASE_VERSION = 1;
const STORE_NAME = "index-state";

export interface PersistedIndexState {
  id: string;
  rootPath: string;
  updatedAt: string;
  entries: DiscoveredEntry[];
  favorites: string[];
  blacklisted?: string[];
  failures?: FailureRecord[];
  checkpoint?: TreeScanCheckpoint;
  graph?: SerializedGraph;
  loadedDirectories?: string[];
  directoryPagination?: Record<string, { nextPage: number; loaded: number; total: number; complete: boolean }>;
  directoryLoadedAt?: Record<string, string>;
  seenUrls?: string[];
  directoryErrors?: Record<string, FailureRecord>;
  expandedDirectories?: string[];
}

export async function loadIndexState(id: string): Promise<PersistedIndexState | undefined> {
  const database = await openDatabase();
  try {
    return await requestAsPromise(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(id)) as PersistedIndexState | undefined;
  } finally {
    database.close();
  }
}

export async function saveIndexState(state: PersistedIndexState): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(state);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function deleteIndexState(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开 IndexedDB"));
  });
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务已中止"));
  });
}
