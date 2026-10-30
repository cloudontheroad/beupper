import { apiUrl, readJsonResponse } from "./api-client";

let inFlight: Promise<any> | null = null;
export function learnLatestDouyinSnapshot(): Promise<any> {
  if (!inFlight) inFlight = runLearning().finally(() => { inFlight = null; });
  return inFlight;
}

async function runLearning() {
  const read = (key: string, fallback: any) => JSON.parse(window.localStorage.getItem(key) || JSON.stringify(fallback));
  const snapshotAt = read("financial-titan-douyin-sync-snapshots", [])[0]?.collectedAt || "";
  const signal = () => window.dispatchEvent(new Event("financial-titan-strategy-updated"));
  const status = (value: any) => {
    window.localStorage.setItem("financial-titan-learning-status", JSON.stringify({ ...value, snapshotAt, updatedAt: new Date().toISOString() })); signal();
  };
  const apiKey = window.localStorage.getItem("financial-titan-deepseek-key") || "";
  if (!apiKey) { status({ state: "blocked", error: "未配置 DeepSeek Key；同步数据已保存，可配置后重试学习" }); throw new Error("请先配置 DeepSeek Key"); }
  const live = read("financial-titan-douyin-live-reviews", []);
  const projects = read("financial-titan-projects", []);
  const focus = read("financial-titan-douyin-last-focus", {}).rows || [];
  const bindings = read("financial-titan-douyin-review-bindings", {});
  if (!live.length) { status({ state: "blocked", error: "当前浏览器没有已同步作品" }); throw new Error("尚无已同步作品，请先同步抖音数据"); }
  const identity = (r: any) => String(r.platformId || r.id || `${r.title}|${r.publishedAt}`);
  const records = [...new Map<string, any>(live.map((review: any) => [identity(review), review])).values()]
    .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
    .map((performance) => {
      const project = projects.find((p: any) => (bindings[p.id] && String(bindings[p.id]) === String(performance.id || ""))
        || (p.douyinReview && identity(p.douyinReview) === identity(performance)));
      const context = project?.topicContext || {};
      return { projectId: project?.id || "", projectMatched: Boolean(project), topic: project?.topic || "",
        title: performance.title || project?.packaging?.title || "", hook: project?.packaging?.hook || "",
        coreConflict: project?.packaging?.conflict || "", scriptOpening: String(project?.script || "").slice(0, 700),
        scriptLength: String(project?.script || "").length,
        retailAttentionEvidence: { priorScore: context.investorProximity, sourceCount: context.sourceCount, socialCount: context.socialCount,
          evidence: (context.evidence || []).filter((e: any) => e.social || /xueqiu|x\.com|twitter|雪球/.test(e.url || "")).map((e: any) => ({ title: e.title, snippet: String(e.snippet || "").slice(0, 250), url: e.url })).slice(0, 5) },
        performance };
    });
  status({ state: "running", recordCount: records.length, startedAt: new Date().toISOString() });
  try {
    const response = await fetch(apiUrl("/api/strategy-iterate"), {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(360_000),
      body: JSON.stringify({ apiKey, model: "deepseek-v4-pro", records, focus,
        focusRecords: focus.map((f: any) => records.find((r) => identity(r.performance) === f.id)).filter(Boolean),
        previousStrategy: read("financial-titan-strategy-profile", {}), strategyHistory: read("financial-titan-strategy-iterations", []) }),
    });
    const payload = await readJsonResponse(response, "策略学习");
    if (!response.ok || !payload.ok) throw new Error(payload.error || "策略学习失败");
    const history = read("financial-titan-strategy-iterations", []);
    window.localStorage.setItem("financial-titan-strategy-iterations", JSON.stringify([payload.iteration, ...history].slice(0, 50)));
    window.localStorage.setItem("financial-titan-strategy-profile", JSON.stringify(payload.iteration));
    const candidates = new Map<string, any>(read("financial-titan-promotion-candidates", []).map((c: any) => [c.id, c]));
    for (const c of payload.promotionCandidates || []) if (!candidates.has(c.id) || candidates.get(c.id).status === "pending") candidates.set(c.id, c);
    window.localStorage.setItem("financial-titan-promotion-candidates", JSON.stringify([...candidates.values()]));
    status({ state: "succeeded", iterationId: payload.iteration.id, recordCount: records.length, warning: payload.promotionWarning || "" });
    return payload;
  } catch (error) {
    status({ state: "failed", recordCount: records.length, error: error instanceof Error ? error.message : String(error) }); throw error;
  }
}
