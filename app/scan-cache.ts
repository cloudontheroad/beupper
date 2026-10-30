const legacyKey = "financial-titan-baidu-last-scan";

function openScanDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open("financial-titan-cache", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("snapshots")) request.result.createObjectStore("snapshots");
    };
    request.onerror = () => reject(request.error || new Error("无法打开扫描缓存"));
    request.onblocked = () => reject(new Error("扫描缓存升级被其他页面阻塞，请关闭旧页面后重试"));
    request.onsuccess = () => resolve(request.result);
  });
}

// Large diagnostic/evidence payloads belong in IndexedDB, not the small
// localStorage quota shared by projects and credentials. Keep the full evidence.
export async function saveScanCache(scan: any): Promise<void> {
  const database = await openScanDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("snapshots", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("扫描缓存写入失败"));
      transaction.onabort = () => reject(transaction.error || new Error("扫描缓存写入被取消"));
      transaction.objectStore("snapshots").put(scan, "last-scan");
    });
    // Remove only the redundant scan cache, and only after durable commit.
    window.localStorage.removeItem(legacyKey);
  } finally { database.close(); }
}

export async function loadScanCache(): Promise<any | null> {
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy) {
    // An old version may have saved a newer scan; migrate it without touching
    // projects, settings, API keys, or the old copy on storage failure.
    try {
      const scan = JSON.parse(legacy);
      try { await saveScanCache(scan); } catch { /* The original remains intact. */ }
      return scan;
    } catch { /* A corrupt legacy cache must not break page initialization. */ }
  }
  const database = await openScanDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("snapshots", "readonly");
      const request = transaction.objectStore("snapshots").get("last-scan");
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("扫描缓存读取被取消"));
    });
  } finally { database.close(); }
}
