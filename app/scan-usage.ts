import { AsyncLocalStorage } from "node:async_hooks";

export type ScanUsage = { calls: number; promptTokens: number; completionTokens: number; cachedTokens: number; inputCharacters: number };
export const scanUsage = new AsyncLocalStorage<ScanUsage>();
export function newScanUsage(): ScanUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, inputCharacters: 0 };
}
