export type SearchProvider = "baidu" | "deepseek";

export function deepSeekSearchQuery(query: string, now = Date.now()) {
  const after = new Date(now - 72 * 3_600_000).toISOString().slice(0, 10);
  const suffix = ` after:${after}`;
  return Array.from(query.trim()).slice(0, 128 - suffix.length).join("") + suffix;
}

export async function searchDeepSeek(apiKey: string, query: string, count = 10, transport: typeof fetch = fetch) {
  const response = await transport("https://api.deepseek.com/v1/tools/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: deepSeekSearchQuery(query), count: Math.max(1, Math.min(50, count)), need_content: false }),
    signal: AbortSignal.timeout(45_000),
  });
  const raw = await response.text();
  let payload: any;
  try { payload = JSON.parse(raw); } catch { throw new Error(`DeepSeek Search HTTP ${response.status}：接口返回非JSON响应`); }
  if (!response.ok) throw new Error(`DeepSeek Search HTTP ${response.status}：${payload.error?.message || raw.slice(0, 200)}`);
  if (!Array.isArray(payload.results)) throw new Error("DeepSeek Search 返回结构异常：缺少 results");
  return {
    query, requestId: response.headers.get("x-request-id") || "deepseek-search",
    references: payload.results.map((item: any) => ({
      title: String(item.title || ""), url: String(item.url || ""),
      // Keep the richer search summary, never duplicate it with page content.
      snippet: String(item.summary || item.snippet || ""), date: item.date || "",
      site_name: item.site_name || "", searchAuthority: item.authority,
      searchRelevance: item.rerank_score, provider: "deepseek",
    })),
  };
}
