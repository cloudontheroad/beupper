import { uncoveredTopicEvents, isGenericTopicTitle } from "../../topic-completion";
import { discoveryQueries } from "../../topic-taxonomy";
import { buildCausalAnalysisTopics, planScanFollowUps, scoreCausalAnalysisTopic, scoreSemanticEvent, standardizeFinancialEvents } from "../../hotspot-semantic";
import { searchDeepSeek, type SearchProvider } from "../../search-provider";
import { newScanUsage, scanUsage } from "../../scan-usage";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const authorityPattern = /reuters|bloomberg|cnbc|wsj|ft\.com|apnews|sec\.gov|investor\.|\/ir(?:\/|-)|gcs-web|hkexnews|hkex\.com|sse\.com|szse\.cn|bse\.cn|fcc\.gov|bis\.gov|commerce\.gov|federalregister\.gov|nasdaq\.com|nyse\.com|fed|treasury|imf|财联社|证券时报|上海证券报|中国证券报|交易所|证监会|人民银行|统计局|公司公告/i;
const socialPattern = /twitter|weibo|微博|douyin|抖音|bilibili|b站|雪球|xueqiu|reddit|youtube|tiktok|x\.com/i;
const operatingCatalystPattern = /发布会|新品|新车|新机|新产品|售价|定价|预售|订单|锁单|交付|销量|量产|扩产|中标|大客户|召回|停产|延期|同店|翻台率|客流|门店|开店|闭店|店效|入住率|客单价|票房|零售额|提价|促销|折扣|联名|加盟|菜单|渠道|库存|出货|预订|会员|product launch|new model|pricing|preorder|orders|deliveries|sales|production|recall|same.store|comparable sales|store openings?|store closures?|traffic|occupancy|revpar|box office|gmv|average ticket|price increase|promotion|discount|franchise/i;
const consumerCompanyPattern = /消费|餐饮|食品|饮料|白酒|乳业|零售|商超|电商|旅游|酒店|航空|服饰|鞋服|运动品牌|美妆|日化|家电|汽车|潮玩|玩具|电影|影视|娱乐|免税|consumer|restaurant|food|beverage|retail|travel|hotel|apparel|sportswear|beauty|cosmetic|appliance|auto|toy|box office/i;
const leadershipSignalPattern = /行业领袖|创始人|企业家|首席执行官|CEO|投资大师|关键人物|公开表态|发言|演讲|采访|警告|呼吁|支持|反对|联名|共识|放缓|暂停|监管|founder|chief executive|CEO|industry leader|investor|policymaker|statement|speech|interview|warns?|calls? for|supports?|opposes?|agree|slow down|pause/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SOURCE_WINDOW_HOURS = 72;
const SOURCE_WINDOW_MS = SOURCE_WINDOW_HOURS * 3_600_000;

function referenceText(reference: any) {
  return `${reference.title || ""} ${reference.snippet || reference.abstract || reference.content || ""} ${reference.url || ""}`;
}

function parseReferenceDate(value: unknown) {
  if (!value) return null;
  const normalized = String(value).trim().replace(" ", "T");
  const parsed = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseUrlDate(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    const match = url.pathname.match(/(?:^|\/)(20\d{2})[-_/]?(0[1-9]|1[0-2])[-_/]?([0-2]\d|3[01])(?:\/|[-_.]|$)/);
    if (!match) return null;
    const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch { return null; }
}

function parseInlineDate(reference: any) {
  const text = referenceText(reference);
  const chinaNow = new Date(Date.now() + 8 * 3_600_000);
  const year = chinaNow.getUTCFullYear();
  const full = text.match(/(20\d{2})[年\-/](\d{1,2})[月\-/](\d{1,2})日?/);
  const short = text.match(/(?:^|\D)(\d{1,2})月(\d{1,2})日/);
  const parts = full ? [Number(full[1]), Number(full[2]), Number(full[3])] : short ? [year, Number(short[1]), Number(short[2])] : null;
  if (!parts) return null;
  const parsed = new Date(`${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}T12:00:00+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildScanQueries(now = new Date()) {
  const chinaNow = new Date(now.getTime() + 8 * 3_600_000);
  const chinaDate = `${chinaNow.getUTCFullYear()}年${chinaNow.getUTCMonth() + 1}月${chinaNow.getUTCDate()}日`;
  const nyParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const nyDate = `${nyParts.find((item) => item.type === "year")?.value}-${nyParts.find((item) => item.type === "month")?.value}-${nyParts.find((item) => item.type === "day")?.value}`;
  return [...new Set(discoveryQueries().map((query) => {
    if (/美股|标普|纳斯达克|道琼斯|wall street|global stocks/i.test(query)) return `${chinaDate} 美东交易日${nyDate} 最新收盘 ${query}`;
    if (chinaNow.getUTCHours() >= 15 && /A股|沪指|上证|深成指|创业板|科创|两市/.test(query)) return `${chinaDate} 今日收盘 收盘后发布 ${query}`;
    if (/财报|业绩|公告|披露|盘前盘后|earnings|results|guidance|filing/i.test(query)) return `${chinaDate} 刚刚 今日最新 ${query}`;
    return `${chinaDate} 过去72小时 ${query}`;
  }))];
}

function isFreshReference(reference: any) {
  const rawDate = reference.date || reference.published_time || reference.publish_time;
  const urlDate = parseUrlDate(reference.url);
  const date = parseReferenceDate(rawDate) || urlDate || parseInlineDate(reference);
  if (!date) return false;
  const ageMs = Date.now() - date.getTime();
  if (ageMs < 0 || ageMs > SOURCE_WINDOW_MS) return false;
  // 搜索接口偶尔把重新抓取时间当成发布时间。URL 中明确存在旧发布日期时，
  // 以原始文章日期为准，防止 2018 年行情被包装成今天的实时价格。
  if (urlDate) {
    const urlAgeMs = Date.now() - urlDate.getTime();
    if (urlAgeMs < 0 || urlAgeMs > SOURCE_WINDOW_MS) return false;
    if (Math.abs(date.getTime() - urlDate.getTime()) > 72 * 3_600_000) return false;
  }
  const query = String(reference.query || "");
  const chinaNow = new Date(Date.now() + 8 * 3_600_000);
  const chinaPublished = new Date(date.getTime() + 8 * 3_600_000);
  const sameChinaDate = chinaPublished.getUTCFullYear() === chinaNow.getUTCFullYear()
    && chinaPublished.getUTCMonth() === chinaNow.getUTCMonth()
    && chinaPublished.getUTCDate() === chinaNow.getUTCDate();
  if (/今日收盘|收盘后发布/.test(query) && !sameChinaDate) return false;
  const usSession = query.match(/美东交易日(\d{4}-\d{2}-\d{2})/);
  if (usSession && !sameChinaDate && !String(rawDate).startsWith(usSession[1])) return false;
  return true;
}

// 财报日历也必须通过统一的 72 小时来源硬门，旧日历不能绕过来源时效约束。
function isCorporateCalendarSeed(reference: any) {
  const query = String(reference.query || "");
  const text = referenceText(reference);
  if (!/财报日历|业绩发布时间|earnings calendar|reporting before open|after close/i.test(query)) return false;
  if (!/财报|业绩|earnings|results|report|conference call/i.test(text)) return false;
  const date = parseReferenceDate(reference.date || reference.published_time || reference.publish_time) || parseUrlDate(reference.url) || parseInlineDate(reference);
  if (!date) return false;
  const ageMs = Date.now() - date.getTime();
  return ageMs >= 0 && ageMs <= SOURCE_WINDOW_MS;
}

function freshnessForAge(ageHours: number) {
  return ageHours <= 2 ? 100 : ageHours <= 8 ? 94 : ageHours <= 24 ? 70 : ageHours <= 48 ? 28 : ageHours <= 72 ? 12 : 0;
}

function freshnessLane(ageHours: number) {
  return ageHours <= 2 ? "breaking_2h" : ageHours <= 8 ? "current_session_8h" : ageHours <= 24 ? "today_24h" : ageHours <= 48 ? "background_48h" : "background_72h";
}

function isVerifiedCurrentEvent(event: any) {
  if (event?.isCurrentEvent !== true || !String(event?.currentAction || "").trim()) return false;
  if (!event?.occurredAt || event?.timeConfidence === "low") return false;
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt)) return false;
  const ageMs = Date.now() - occurredAt;
  return ageMs >= -6 * 3_600_000 && ageMs <= SOURCE_WINDOW_MS;
}

function isOperatingCatalystEvent(event: any) {
  const text = `${event?.title || ""} ${event?.summary || ""} ${(event?.actions || []).join(" ")} ${(event?.objects || []).join(" ")}`;
  const operatingAction = operatingCatalystPattern.test(text);
  const listedCompanySignal = event?.family === "corporate" || (event?.actors || []).length > 0 || (event?.assets || []).length > 0;
  return operatingAction && listedCompanySignal;
}

function specificCompanyEntities(event: any) {
  const generic = /^(消费者?|投资者|股民|市场|行业|公司|企业|品牌|板块|消费股|消费行业|A股|港股|美股|中概股|零售业|餐饮业|汽车业)$/i;
  return [...new Set([...(event?.actors || []), ...(event?.assets || [])]
    .map((item: unknown) => String(item).trim())
    .filter((item: string) => item.length >= 2 && item.length <= 40 && !generic.test(item)))];
}

function isConsumerCompanyEvent(event: any) {
  const text = `${event?.title || ""} ${event?.summary || ""} ${(event?.actors || []).join(" ")} ${(event?.actions || []).join(" ")} ${(event?.objects || []).join(" ")} ${(event?.sectors || []).join(" ")}`;
  return isOperatingCatalystEvent(event) && consumerCompanyPattern.test(text) && specificCompanyEntities(event).length > 0;
}

function hasVerifiedAudienceSignal(event: any) {
  const sources = Number(event?.sourceCount || 0);
  const authorities = Number(event?.authorityCount || 0);
  const social = Number(event?.socialCount || 0);
  const reaction = Number(event?.marketReaction || 0);
  // 不以公司名单或模型声称“热门”为依据，只承认证据层可观察的传播或价格信号。
  return (sources >= 2 && social >= 1)
    || (sources >= 2 && reaction >= 55)
    || (sources >= 3 && authorities >= 1)
    || reaction >= 75;
}

function isUSLinkedTopic(topic: any) {
  const text = `${topic?.title || ""} ${(topic?.markets || []).join(" ")} ${(topic?.evidence || []).map((item: any) => `${item.title || ""} ${item.query || ""}`).join(" ")}`;
  return /美股|美国股市|标普|纳斯达克|纳指|道琼斯|纽交所|NASDAQ|NYSE|S&P|Dow|US stocks?|Wall Street/i.test(text);
}

async function search(apiKey: string, query: string, topK = 10) {
  const rawKey = apiKey.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "");
  const qianfanMatch = rawKey.match(/bce-v3\/[A-Za-z0-9._/-]+/);
  const cleanKey = qianfanMatch?.[0] || rawKey.replace(/^(?:API_KEY|BAIDU_API_KEY)\s*=\s*/i, "").trim();
  if (/^bsk/i.test(cleanKey)) throw new Error("BSK Key 不能用于百度千帆，请填写完整的 bce-v3/... Key。");
  const body = JSON.stringify({
    messages: [{ role: "user", content: query.slice(0, 72) }],
    edition: "standard", search_source: "baidu_search_v2",
    resource_type_filter: [{ type: "web", top_k: topK }, { type: "video", top_k: Math.min(5, topK) }],
    search_recency_filter: "week", sort: { priority: "auto" },
  });
  const headerNames = cleanKey.startsWith("bce-v3/") ? ["Authorization"] : ["X-Appbuilder-Authorization", "Authorization"];
  let lastError = "";
  for (const headerName of headerNames) {
    let response: Response;
    try {
      response = await fetch("https://qianfan.baidubce.com/v2/ai_search/web_search", {
        method: "POST", headers: { [headerName]: `Bearer ${cleanKey}`, "Content-Type": "application/json" }, body,
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`百度 WebSearch 网络请求失败：${detail}`);
    }
    const text = await response.text();
    let payload: any = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    if (response.ok && !payload.code) return { query, requestId: payload.request_id, references: payload.references || payload.data || [] };
    lastError = `千帆 V2 Key 请求失败（HTTP ${response.status}）：${payload.message || payload.error?.message || text.slice(0, 300) || response.status}`;
    if (![401, 403].includes(response.status)) break;
  }
  throw new Error(lastError);
}

async function throttledSearch(apiKey: string, query: string, previousRequestAt = 0, topK = 10, provider: SearchProvider = "baidu") {
  const gap = Date.now() - previousRequestAt;
  if (gap < 1100) await sleep(1100 - gap);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return { result: provider === "deepseek" ? await searchDeepSeek(apiKey, query, topK) : await search(apiKey, query, topK), requestedAt: Date.now() }; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /qps|rate.?limit|429|too many|频率|并发|fetch failed|network|socket|timed?\s*out|abort|HTTP 5\d\d|连接|网络请求失败/i.test(message);
      if (!transient || attempt === 2) throw error;
      await sleep(2500 * (attempt + 1));
    }
  }
  throw new Error("百度搜索请求未完成");
}

function normalize(value: string) { return String(value || "").replace(/<[^>]+>/g, "").replace(/[\s\u3000]+/g, "").toLowerCase(); }
function bigrams(value: string) { const text = normalize(value); return text.length < 2 ? [text] : Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)); }
function similarity(left: string, right: string) {
  const a = new Set(bigrams(left)); const b = new Set(bigrams(right));
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function contentDeduplicate(references: any[]) {
  const kept: any[] = []; const duplicateIds = new Set<string>();
  for (const reference of references) {
    const text = `${reference.title || ""}${reference.snippet || reference.abstract || reference.content || ""}`;
    const duplicate = kept.find((item) => similarity(text, `${item.title || ""}${item.snippet || item.abstract || item.content || ""}`) >= 0.72);
    if (duplicate) duplicateIds.add(reference.traceId); else kept.push(reference);
  }
  return { kept, duplicateIds };
}

function formatReference(reference: any, batch: any, batchIndex: number, referenceIndex: number) {
  return {
    ...reference, traceId: `ref-${batchIndex + 1}-${referenceIndex + 1}`,
    site_name: reference.website || reference.site_name || "", query: batch.query,
  };
}

export async function POST(request: Request) {
  return scanUsage.run(newScanUsage(), () => scanRequest(request));
}

async function scanRequest(request: Request) {
  try {
    const { apiKey, deepseekApiKey, searchProvider = "baidu", strategyProfile = {}, xueqiuCookie = "", twitterAuthToken = "", twitterCt0 = "", action = "test" } = await request.json();
    if (!["baidu", "deepseek"].includes(searchProvider)) return Response.json({ error: "未知搜索数据源" }, { status: 400 });
    const provider = searchProvider as SearchProvider;
    const sourceKey = provider === "deepseek" ? deepseekApiKey : apiKey;
    const sourceName = provider === "deepseek" ? "DeepSeek Search" : "百度 WebSearch";
    if (!sourceKey?.trim()) return Response.json({ error: `请填写${sourceName} API Key。` }, { status: 400 });
    if (action === "test") {
      const { result } = await throttledSearch(sourceKey, "今日全球资本市场热点", 0, 3, provider);
      return Response.json({ ok: true, searchProvider: provider, requestId: result.requestId, resultCount: result.references.length, sample: result.references.slice(0, 3) });
    }
    if (!deepseekApiKey) return Response.json({ error: "请填写 DeepSeek API Key，用于动态实体、动作提取与事件标准化。" }, { status: 400 });

    const baseQueries = buildScanQueries(); const batches: any[] = []; const failedQueries: any[] = []; let previousRequestAt = 0;
    for (const query of baseQueries) {
      const calendarQuery = /财报日历|业绩发布时间|earnings calendar|reporting before open|after close/i.test(query);
      const operatingCatalystQuery = /发布会|新品|新车|新机|产品定价|预售|订单|锁单|交付|销量|量产|扩产|中标|召回|停产|同店|翻台率|客流|门店|店效|入住率|客单价|票房|零售额|提价|促销|折扣|渠道|库存|same.store|comparable sales|store openings?|traffic|occupancy|revpar|box office|gmv|product launch|new model|pricing|preorder/i.test(query);
      const leadershipSignalQuery = /行业领袖|关键人物|创始人|CEO|公开表态|警告|呼吁|联名|industry leaders|founders|executives|policymakers|statement|speech|interview/i.test(query);
      try {
        const response = await throttledSearch(sourceKey, query, previousRequestAt, calendarQuery || operatingCatalystQuery || leadershipSignalQuery ? 20 : 10, provider); previousRequestAt = response.requestedAt; batches.push(response.result);
      } catch (error) {
        if (/HTTP (401|402|403)\b|insufficient balance|余额不足/i.test(error instanceof Error ? error.message : String(error))) throw error;
        previousRequestAt = Date.now();
        failedQueries.push({ stage: "基础召回", query, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!batches.length) throw new Error(`${sourceName} 的 ${baseQueries.length} 组基础查询全部失败：${failedQueries[0]?.error || "未知网络错误"}`);
    const firstPass = batches.flatMap((batch, batchIndex) => batch.references.map((reference: any, index: number) => formatReference(reference, batch, batchIndex, index)));
    const firstPassEligible = firstPass.filter((item) => isFreshReference(item) || isCorporateCalendarSeed(item));
    const seedUrls = new Set<string>();
    const firstPassSeeds = contentDeduplicate(firstPassEligible.filter((item) => {
      const key = item.url || item.title; if (seedUrls.has(key)) return false; seedUrls.add(key); return true;
    })).kept;
    const firstPassSemantic = firstPassSeeds.map((item: any) => ({
      traceId: item.traceId, title: item.title || "", snippet: item.snippet || item.abstract || item.content || "", url: item.url || "",
      site: item.site_name || "", publishedAt: item.date || item.published_time || item.publish_time || "", query: item.query,
      authoritative: authorityPattern.test(referenceText(item)),
      social: socialPattern.test(referenceText(item)),
    }));
    const corporateFollowUp = await planScanFollowUps(deepseekApiKey, firstPassSemantic);
    const allFollowUpQueries = corporateFollowUp.queries.filter((q) => !baseQueries.includes(q));
    for (const query of allFollowUpQueries.filter((item) => !baseQueries.includes(item))) {
      try {
        const response = await throttledSearch(sourceKey, query, previousRequestAt, 10, provider); previousRequestAt = response.requestedAt; batches.push(response.result);
      } catch (error) {
        if (/HTTP (401|402|403)\b|insufficient balance|余额不足/i.test(error instanceof Error ? error.message : String(error))) throw error;
        previousRequestAt = Date.now();
        failedQueries.push({ stage: "事件追踪", query, error: error instanceof Error ? error.message : String(error) });
      }
    }
    let socialChannels: any = { xueqiu: { ok: false, count: 0, error: "未执行" }, twitter: { ok: false, count: 0, error: "未执行" } };
    // The scan only samples discussion for discovery/heat. The selected event
    // receives a full, frozen social-evidence refresh in the research stage.
    const socialQueries = allFollowUpQueries.filter((item) => /雪球|twitter|x\/twitter|投资者讨论|分歧|热议/i.test(item)).slice(0, 3);
    // Browser sessions live in the local gateway. Manual credentials are only
    // a backward-compatible fallback and must not gate social recall.
    if (socialQueries.length) {
      try {
        const socialResponse = await fetch("http://127.0.0.1:4318/api/social-search", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ queries: socialQueries, xueqiuCookie, twitterAuthToken, twitterCt0 }),
          signal: AbortSignal.timeout(60_000),
        });
        const socialPayload: any = await socialResponse.json();
        if (socialResponse.ok && socialPayload.ok) {
          socialChannels = socialPayload.channels || socialChannels;
          if (socialPayload.references?.length) batches.push({ query: "Agent-Reach社交直连", requestId: "social-local", references: socialPayload.references });
        } else socialChannels = { ...socialChannels, gatewayError: socialPayload.error || `HTTP ${socialResponse.status}` };
      } catch (error) {
        socialChannels = { ...socialChannels, gatewayError: error instanceof Error ? error.message : String(error) };
      }
    }

    const collected = batches.flatMap((batch, batchIndex) => batch.references.map((reference: any, index: number) => formatReference(reference, batch, batchIndex, index)));
    const fresh = collected.filter(isFreshReference); const timeFilteredIds = new Set(collected.filter((item) => !isFreshReference(item)).map((item) => item.traceId));
    const seenUrls = new Set<string>(); const urlDuplicateIds = new Set<string>();
    const urlUnique = fresh.filter((item) => { const key = item.url || item.title; if (!key || seenUrls.has(key)) { urlDuplicateIds.add(item.traceId); return false; } seenUrls.add(key); return true; });
    const deduped = contentDeduplicate(urlUnique); const references = deduped.kept;
    const semanticReferences = references.map((item: any) => ({
      traceId: item.traceId, title: item.title || "", snippet: item.snippet || item.abstract || item.content || "", url: item.url || "",
      site: item.site_name || "", publishedAt: item.date || item.published_time || item.publish_time || "", query: item.query,
      authoritative: authorityPattern.test(referenceText(item)),
      social: socialPattern.test(referenceText(item)),
    }));
    const semantic = await standardizeFinancialEvents(deepseekApiKey, semanticReferences);
    const referenceById = new Map(semanticReferences.map((item) => [item.traceId, item]));
    const excludedBackgroundEvents = semantic.events.filter((event: any) => !isVerifiedCurrentEvent(event));
    const currentEvents = semantic.events.filter(isVerifiedCurrentEvent);
    const ranked = currentEvents.map((event: any) => {
      const eventEvidence = event.evidenceIds.map((id: string) => referenceById.get(id)).filter(Boolean) as any[];
      const scoring = scoreSemanticEvent(event, eventEvidence);
      return {
        ...event, ...scoring, thesis: event.summary, category: event.family,
        trigger: [event.actors.join("、"), event.actions.join("、")].filter(Boolean).join(" · ") || event.title,
        socialCount: eventEvidence.filter((item) => socialPattern.test(`${item.url} ${item.site}`)).length,
        heat: event.marketReaction, fit: Math.round((event.novelty + event.confidence) / 2), depth: Math.min(100, event.transmission.length * 18 + event.confidence * 0.6),
        freshness: `${scoring.ageHours}小时前`, freshnessScore: freshnessForAge(scoring.ageHours), freshnessLane: freshnessLane(scoring.ageHours),
        gates: { hardGate: true, reasons: scoring.warnings }, rejectionReasons: scoring.warnings,
        evidence: eventEvidence.map((item) => ({
          title: item.title, url: item.url, site: item.site, publishedAt: item.publishedAt,
          snippet: item.snippet, query: item.query, authoritative: item.authoritative, social: Boolean(item.social), score: 0,
        })),
      };
    }).sort((a: any, b: any) => b.score - a.score);
    const events = ranked.map((event: any, index: number) => ({ ...event, id: `event-${index + 1}`, rank: index + 1, eligible: true, status: "已发现", eventRole: event.family === "market_move" ? "行情事实" : "原因事件" }));
    let topicSkill = "";
    try { topicSkill = await readFile(path.join(process.cwd(), "skills", "discover-financial-topics", "SKILL.md"), "utf-8"); } catch {}
    const causal = await buildCausalAnalysisTopics(deepseekApiKey, events, strategyProfile, topicSkill);
    const eventById = new Map(events.flatMap((event: any) => [[event.id, event], [event.eventId, event]]));
    const augmentedAnalyses = causal.topics.filter((topic) => !isGenericTopicTitle(topic.title));
    const recentCorporateEvents = events.filter((event: any) =>
      event.ageHours <= 8
      && (event.family === "corporate" || /财报|业绩|盈利|指引|earnings|results|guidance/i.test(`${event.title} ${event.summary}`))
      && hasVerifiedAudienceSignal(event),
    ).slice(0, 4);
    // 发布会常在晚间，真正可分析的本股反应发生在次日交易时段，因此给予24小时窗口；
    // 保护的是通用经营动作类别，不是任何公司名单。
    const recentOperatingCatalystEvents = events.filter((event: any) =>
      event.ageHours <= 24 && isOperatingCatalystEvent(event) && hasVerifiedAudienceSignal(event),
    ).slice(0, 4);
    const recentConsumerCompanyEvents = events.filter((event: any) =>
      event.ageHours <= 24 && isConsumerCompanyEvent(event) && hasVerifiedAudienceSignal(event),
    ).slice(0, 4);
    const recentLeadershipEvents = events.filter((event: any) =>
      event.ageHours <= 24
      && leadershipSignalPattern.test(`${event.title} ${event.summary} ${(event.actors || []).join(" ")} ${(event.actions || []).join(" ")}`)
      && hasVerifiedAudienceSignal(event),
    ).slice(0, 3);
    // 事件榜前列只要求模型生成分析候选，不再自动获得高潜池席位。
    // 保护名额只属于有可验证声量/价格信号的财报与经营催化剂。
    const protectedEvents = [...new Map([...recentCorporateEvents, ...recentOperatingCatalystEvents, ...recentConsumerCompanyEvents, ...recentLeadershipEvents].map((event: any) => [event.id, event])).values()];
    const missingEvents = uncoveredTopicEvents(protectedEvents, augmentedAnalyses,
      [...recentOperatingCatalystEvents, ...recentConsumerCompanyEvents], specificCompanyEntities);
    let supplementalReceipt = "";
    let supplementalError = "";
    if (missingEvents.length) {
      try {
        const supplemental = await buildCausalAnalysisTopics(deepseekApiKey, missingEvents, strategyProfile, topicSkill, true);
        supplementalReceipt = supplemental.receipt;
        // Validate against the same evolving candidate pool, so one event is
        // filled only once even when it belongs to multiple protection lanes.
        for (const event of missingEvents) {
          const remaining = uncoveredTopicEvents([event], augmentedAnalyses,
            [...recentOperatingCatalystEvents, ...recentConsumerCompanyEvents].filter((item) => item.id === event.id), specificCompanyEntities);
          if (!remaining.length) continue;
          const candidate = supplemental.topics.find((topic) => {
            if (isGenericTopicTitle(topic.title) || !topic.mechanism || augmentedAnalyses.some((existing) => existing.title === topic.title)) return false;
            const ids = [...topic.observedEventIds, ...topic.causalEventIds];
            if (!ids.some((id) => id === event.id || id === event.eventId)) return false;
            if (ids.some((id) => !missingEvents.some((item) => item.id === id || item.eventId === id))) return false;
            const companyRequired = recentOperatingCatalystEvents.some((item) => item.id === event.id) || recentConsumerCompanyEvents.some((item) => item.id === event.id);
            return !companyRequired || specificCompanyEntities(event).some((name) => topic.title.includes(name));
          });
          if (candidate) augmentedAnalyses.push(candidate);
        }
      } catch (error) {
        supplementalError = error instanceof Error ? error.message : String(error);
      }
    }
    const pendingAnalysisEvents = uncoveredTopicEvents(protectedEvents, augmentedAnalyses,
      [...recentOperatingCatalystEvents, ...recentConsumerCompanyEvents], specificCompanyEntities);
    const pendingAnalysisIds = new Set(pendingAnalysisEvents.map((event) => event.id));
    const topicCandidates = augmentedAnalyses.map((analysis, index) => {
      const linkedEvents = [...new Set([...analysis.observedEventIds, ...analysis.causalEventIds])]
        .map((id) => eventById.get(id)).filter(Boolean) as any[];
      const evidence = [...new Map(linkedEvents.flatMap((event) => event.evidence || []).map((item: any) => [item.url || item.title, item])).values()];
      const sourceCount = new Set(evidence.map((item: any) => item.site || item.url).filter(Boolean)).size;
      const authorityCount = linkedEvents.reduce((sum, event) => sum + (event.authorityCount || 0), 0);
      const latestAgeHours = linkedEvents.length ? Math.min(...linkedEvents.map((event: any) => Number(event.ageHours ?? 48))) : 48;
      const topicFreshnessScore = freshnessForAge(latestAgeHours);
      const isSingleCompanyCatalyst = linkedEvents.some((event) => event.family === "corporate" || isOperatingCatalystEvent(event));
      const verifiedAudienceSignal = linkedEvents.some(hasVerifiedAudienceSignal);
      const consumerEvent = linkedEvents.find(isConsumerCompanyEvent);
      const consumerEntity = consumerEvent ? specificCompanyEntities(consumerEvent)[0] || "" : "";
      const normalizedTitle = consumerEntity && !String(analysis.title || "").includes(consumerEntity)
        ? `${consumerEntity}：${analysis.title}`
        : analysis.title;
      const rawInvestorProximity = Number(analysis.investorProximity || 0);
      const investorProximity = isSingleCompanyCatalyst
        ? verifiedAudienceSignal ? Math.min(rawInvestorProximity, linkedEvents.some((event) => event.socialCount > 0 || event.marketReaction >= 55) ? 100 : 60) : Math.min(rawInvestorProximity, 45)
        : Math.min(rawInvestorProximity, 50);
      // 模型给出的searchDemand不能代替真实声量。缺少独立来源、社区讨论和
      // 价格反应的单公司题仍可留在事件全集，但在高潜排序中明确降级。
      const attentionPenalty = isSingleCompanyCatalyst && !verifiedAudienceSignal ? 20 : 0;
      const score = Math.max(0, scoreCausalAnalysisTopic({ ...analysis, investorProximity }, topicFreshnessScore) - attentionPenalty);
      return {
        ...analysis, investorProximity, isSingleCompanyCatalyst, isConsumerCompany: Boolean(consumerEvent), consumerEntity, id: index + 1, score, title: normalizedTitle,
        thesis: `${analysis.mechanism}${analysis.counterEvidence ? ` 反证是：${analysis.counterEvidence}` : ""}`,
        category: "原因分析", markets: analysis.markets, trigger: `${analysis.causality} · ${analysis.verificationSignals.join("、")}`,
        sourceCount, authorityCount, socialCount: linkedEvents.reduce((sum, event) => sum + (event.socialCount || 0), 0),
        heat: Math.round(analysis.marketImportance * 0.55 + analysis.searchDemand * 0.45),
        fit: Math.round(analysis.explanatoryPower * 0.6 + analysis.stakeholderConflict * 0.25 + analysis.entitySpecificity * 0.15),
        depth: analysis.evidenceStrength,
        searchDemand: analysis.searchDemand, stakeholderConflict: analysis.stakeholderConflict,
        entitySpecificity: analysis.entitySpecificity, timelinessOpportunity: analysis.timelinessOpportunity,
        verifiedAudienceSignal, attentionPenalty,
        discoveryLane: analysis.discoveryLane,
        freshness: `${latestAgeHours}小时前最新动作`, ageHours: latestAgeHours, freshnessScore: topicFreshnessScore, freshnessLane: freshnessLane(latestAgeHours),
        gates: { hardGate: true, reasons: [] }, rejectionReasons: [], evidence,
        observedEvents: analysis.observedEventIds, causalEvents: analysis.causalEventIds,
      };
    }).sort((a, b) => b.score - a.score);
    const selectedTopics: any[] = [];
    const requiredTitles = new Set<string>();
    for (const event of protectedEvents) {
      const candidate = topicCandidates.find((topic) => [...topic.observedEvents, ...topic.causalEvents].some((id: string) => id === event.id || id === event.eventId));
      if (candidate && !selectedTopics.some((topic) => topic.title === candidate.title)) {
        selectedTopics.push(candidate);
        requiredTitles.add(candidate.title);
      }
    }
    for (const candidate of topicCandidates) {
      if (selectedTopics.length >= 10) break;
      if (!selectedTopics.some((topic) => topic.title === candidate.title)) selectedTopics.push(candidate);
    }
    selectedTopics.sort((a, b) => b.score - a.score);
    // 刚发布的公司财报不应因为美股尚未开盘、市场反应分暂时为零而消失。
    // 最多保护三个不同公司的财报题；它们仍按事件证据和时效排序，不固定任何公司名单。
    const recentCorporateTopics = recentCorporateEvents
      .map((event: any) => topicCandidates.find((topic) => [...topic.observedEvents, ...topic.causalEvents].some((id: string) => id === event.id || id === event.eventId)))
      .filter((topic): topic is NonNullable<typeof topic> => Boolean(topic))
      .filter((topic: any, index: number, list: any[]) => list.findIndex((item: any) => item.title === topic.title) === index)
      .slice(0, 3);
    for (const corporateTopic of recentCorporateTopics) {
      if (selectedTopics.some((topic) => topic.title === corporateTopic.title)) continue;
      const replaceAt = [...selectedTopics].reverse().findIndex((topic) => !requiredTitles.has(topic.title));
      if (replaceAt >= 0) selectedTopics.splice(selectedTopics.length - 1 - replaceAt, 1, corporateTopic);
      else if (selectedTopics.length < 10) selectedTopics.push(corporateTopic);
      requiredTitles.add(corporateTopic.title);
    }
    const operatingCatalystTopics = recentOperatingCatalystEvents
      .map((event: any) => {
        const entities = [...(event.actors || []), ...(event.assets || [])].map(String).filter((item) => item.length >= 2);
        const linked = topicCandidates.filter((topic) => [...topic.observedEvents, ...topic.causalEvents].some((id: string) => id === event.id || id === event.eventId));
        return linked.find((topic) => entities.some((entity) => topic.title.includes(entity))) || linked[0];
      })
      .filter(Boolean)
      .filter((topic: any, index: number, list: any[]) => list.findIndex((item: any) => item.title === topic.title) === index)
      .slice(0, 3);
    for (const catalystTopic of operatingCatalystTopics) {
      if (selectedTopics.some((topic) => topic.title === catalystTopic.title)) continue;
      const replaceAt = [...selectedTopics].reverse().findIndex((topic) => !requiredTitles.has(topic.title));
      if (replaceAt >= 0) selectedTopics.splice(selectedTopics.length - 1 - replaceAt, 1, catalystTopic);
      else if (selectedTopics.length < 10) selectedTopics.push(catalystTopic);
      requiredTitles.add(catalystTopic.title);
    }
    const freshTopics = topicCandidates.filter((topic) => topic.ageHours <= 8);
    if (freshTopics.length && !selectedTopics.slice(0, 5).some((topic) => topic.ageHours <= 8)) {
      const fresh = freshTopics[0];
      const existing = selectedTopics.findIndex((topic) => topic.title === fresh.title);
      if (existing >= 0) {
        selectedTopics.splice(existing, 1);
        selectedTopics.splice(Math.min(4, selectedTopics.length), 0, fresh);
      } else {
        const replaceAt = [...selectedTopics].reverse().findIndex((topic) => !requiredTitles.has(topic.title));
        if (replaceAt >= 0) selectedTopics.splice(selectedTopics.length - 1 - replaceAt, 1, fresh);
      }
    }
    const desiredFreshCount = Math.min(2, freshTopics.length);
    for (const fresh of freshTopics) {
      if (selectedTopics.filter((topic) => topic.ageHours <= 8).length >= desiredFreshCount) break;
      if (selectedTopics.some((topic) => topic.title === fresh.title)) continue;
      const replaceAt = [...selectedTopics].reverse().findIndex((topic) => topic.ageHours > 8 && !requiredTitles.has(topic.title));
      if (replaceAt >= 0) selectedTopics.splice(selectedTopics.length - 1 - replaceAt, 1, fresh);
    }
    // 个人投资者更容易进入具体公司问题。若当轮确有合格候选，前五尽量保留
    // 两个“24小时内 + 有真实关注信号 + 本股定价明确”的公司题；不设公司白名单。
    const investorCloseCompanyTopics = topicCandidates.filter((topic) =>
      topic.isSingleCompanyCatalyst && topic.verifiedAudienceSignal && topic.ageHours <= 24 && topic.investorProximity >= 60,
    );
    const desiredCompanyTopFive = Math.min(2, investorCloseCompanyTopics.length);
    for (const companyTopic of investorCloseCompanyTopics.slice(0, desiredCompanyTopFive)) {
      let currentIndex = selectedTopics.findIndex((topic) => topic.title === companyTopic.title);
      if (currentIndex < 0) {
        const replaceAt = [...selectedTopics].reverse().findIndex((topic) => !requiredTitles.has(topic.title));
        if (replaceAt >= 0) selectedTopics.splice(selectedTopics.length - 1 - replaceAt, 1, companyTopic);
        else if (selectedTopics.length < 10) selectedTopics.push(companyTopic);
        currentIndex = selectedTopics.findIndex((topic) => topic.title === companyTopic.title);
      }
      if (currentIndex >= 5) {
        selectedTopics.splice(currentIndex, 1);
        selectedTopics.splice(Math.min(4, selectedTopics.length), 0, companyTopic);
      }
    }
    // 消费股不是按品牌名单保送：仅当24小时内确有经营新动作且具备真实声量时，
    // 才保证最强的一条进入前五，避免宏观题在召回充分时仍把消费公司全部淹没。
    const consumerCompanyTopics = topicCandidates.filter((topic) =>
      topic.isConsumerCompany && topic.verifiedAudienceSignal && topic.ageHours <= 24 && topic.investorProximity >= 60,
    );
    const bestConsumerTopic = consumerCompanyTopics[0];
    if (bestConsumerTopic) {
      let currentIndex = selectedTopics.findIndex((topic) => topic.title === bestConsumerTopic.title);
      if (currentIndex < 0) {
        const replaceAt = [...selectedTopics].reverse().findIndex((topic) => !requiredTitles.has(topic.title));
        if (replaceAt >= 0) selectedTopics.splice(selectedTopics.length - 1 - replaceAt, 1, bestConsumerTopic);
        else if (selectedTopics.length < 10) selectedTopics.push(bestConsumerTopic);
        currentIndex = selectedTopics.findIndex((topic) => topic.title === bestConsumerTopic.title);
      }
      if (currentIndex >= 5) {
        selectedTopics.splice(currentIndex, 1);
        selectedTopics.splice(Math.min(4, selectedTopics.length), 0, bestConsumerTopic);
      }
    }
    // 跨市场是账号定位：当本轮确实存在合格美股候选时，为其保留组合席位，
    // 但没有候选时绝不凭配额创造新闻。
    const usCandidates = topicCandidates.filter(isUSLinkedTopic);
    const desiredUSCount = Math.min(3, usCandidates.length);
    for (const usTopic of usCandidates) {
      if (selectedTopics.filter(isUSLinkedTopic).length >= desiredUSCount) break;
      if (selectedTopics.some((topic) => topic.title === usTopic.title)) continue;
      const replaceAt = [...selectedTopics].reverse().findIndex((topic) => !isUSLinkedTopic(topic) && !requiredTitles.has(topic.title));
      if (replaceAt >= 0) selectedTopics.splice(selectedTopics.length - 1 - replaceAt, 1, usTopic);
      else if (selectedTopics.length < 10) selectedTopics.push(usTopic);
    }
    selectedTopics.sort((a, b) => b.score - a.score);
    const desiredUSTopFive = Math.min(2, usCandidates.length);
    for (const usTopic of selectedTopics.filter(isUSLinkedTopic).slice(0, desiredUSTopFive)) {
      const currentIndex = selectedTopics.findIndex((topic) => topic.title === usTopic.title);
      if (currentIndex >= 5) {
        selectedTopics.splice(currentIndex, 1);
        selectedTopics.splice(Math.min(4, selectedTopics.length), 0, usTopic);
      }
    }
    const priorityTopFive = [...new Map([
      ...investorCloseCompanyTopics.slice(0, desiredCompanyTopFive),
      ...consumerCompanyTopics.slice(0, 1),
      ...selectedTopics.filter(isUSLinkedTopic).slice(0, desiredUSTopFive),
      ...selectedTopics.filter((topic) => topic.ageHours <= 8).slice(0, 1),
    ].map((topic) => [topic.title, topic])).values()]
      .filter((topic) => selectedTopics.some((item) => item.title === topic.title))
      .slice(0, 5)
      .sort((a, b) => b.score - a.score);
    const priorityTitles = new Set(priorityTopFive.map((topic) => topic.title));
    selectedTopics.splice(0, selectedTopics.length, ...priorityTopFive, ...selectedTopics.filter((topic) => !priorityTitles.has(topic.title)));
    const topics = selectedTopics.slice(0, 10).map((topic, index) => ({ ...topic, id: index + 1, status: index < 5 ? "立即做" : "备选" }));
    const topicCoverage = new Map<string, number>();
    for (const topic of topics) for (const id of [...topic.observedEvents, ...topic.causalEvents]) topicCoverage.set(id, (topicCoverage.get(id) || 0) + 1);
    for (const event of events) {
      const count = [...new Set([event.id, event.eventId])].reduce((sum, id) => sum + (topicCoverage.get(id) || 0), 0);
      event.topicCount = count;
      event.status = pendingAnalysisIds.has(event.id) ? "待分析：尚无具体分析题" : count ? "已进入高潜选题" : "已发现，未进入高潜";
    }
    const eventForEvidence = new Map<string, string>(); events.forEach((event: any) => event.evidenceIds.forEach((id: string) => eventForEvidence.set(id, event.eventId)));
    const unclassified = new Set(semantic.unclassifiedEvidenceIds); const retainedIds = new Set(references.map((item: any) => item.traceId));
    // 诊断明细只展示通过 72 小时来源硬门的文章；旧闻只保留淘汰总数。
    const traces = fresh.map((item) => ({
      traceId: item.traceId, title: item.title, url: item.url, query: item.query, publishedAt: item.date || item.published_time || item.publish_time || "",
      status: urlDuplicateIds.has(item.traceId) ? "url_duplicate" : deduped.duplicateIds.has(item.traceId) ? "content_duplicate" : unclassified.has(item.traceId) ? "unclassified" : eventForEvidence.has(item.traceId) ? "assigned_to_event" : retainedIds.has(item.traceId) ? "unassigned" : "unknown",
      eventId: eventForEvidence.get(item.traceId) || "",
    }));
    const counts = traces.reduce((acc: any, item: any) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});
    counts.time_filtered = timeFilteredIds.size;

    const freshnessBuckets = events.reduce((acc: Record<string, number>, event: any) => {
      acc[event.freshnessLane] = (acc[event.freshnessLane] || 0) + 1; return acc;
    }, { breaking_2h: 0, current_session_8h: 0, today_24h: 0, background_48h: 0, background_72h: 0 });
    const latestByMarket = events.reduce((acc: Record<string, any>, event: any) => {
      for (const market of event.markets || []) {
        if (!acc[market] || event.ageHours < acc[market].ageHours) acc[market] = { title: event.title, ageHours: event.ageHours, occurredAt: event.occurredAt };
      }
      return acc;
    }, {});

    return Response.json({
      ok: true, pipelineVersion: "multi-source-efficient-v10", searchProvider: provider, scannedAt: new Date().toISOString(), queryCount: batches.length, baseQueryCount: baseQueries.length,
      followUpQueryCount: allFollowUpQueries.length, followUpQueries: allFollowUpQueries, references,
      collectedReferenceCount: collected.length, timeFilteredOut: timeFilteredIds.size, timeWindowHours: SOURCE_WINDOW_HOURS,
      rawReferenceCount: fresh.length, contentDedupCount: references.length, passed: references,
      topics, rejectedTopics: [], events, discoveredEventCount: events.length,
      categoryCoverage: [...new Set(events.map((item: any) => item.category || "other"))], mainTopicCount: Math.min(5, topics.length),
      semanticReceipts: semantic.receipts, followUpSemanticReceipt: corporateFollowUp.receipt, causalSemanticReceipt: causal.receipt, supplementalSemanticReceipt: supplementalReceipt,
      diagnostics: {
        traces, counts, freshnessBuckets, latestByMarket, failedQueries,
        topicCompletion: { requested: missingEvents.length, pending: pendingAnalysisEvents.map((event) => ({ id: event.id, title: event.title })), receipt: supplementalReceipt, error: supplementalError },
        efficiency: { modelUsage: scanUsage.getStore(), planningRawReferences: firstPassEligible.length, planningUniqueReferences: firstPassSeeds.length, followUpModelCalls: corporateFollowUp.receipt ? 1 : 0, searchRequests: batches.length + failedQueries.length },
        calendarSeedCount: firstPass.filter(isCorporateCalendarSeed).length,
        corporateCalendarCompanies: corporateFollowUp.companies,
        recentCorporateEventCount: recentCorporateEvents.length,
        recentOperatingCatalystEventCount: recentOperatingCatalystEvents.length,
        recentConsumerCompanyEventCount: recentConsumerCompanyEvents.length,
        recentLeadershipEventCount: recentLeadershipEvents.length,
        audienceQualifiedEventCount: events.filter(hasVerifiedAudienceSignal).length,
        usCandidateCount: topicCandidates.filter(isUSLinkedTopic).length,
        usSelectedCount: topics.filter(isUSLinkedTopic).length,
        operatingCatalystFunnel: {
          recalled: collected.filter((item) => operatingCatalystPattern.test(referenceText(item))).length,
          fresh: references.filter((item) => operatingCatalystPattern.test(referenceText(item))).length,
          events: events.filter(isOperatingCatalystEvent).length,
          topics: topics.filter((topic) => [...topic.observedEvents, ...topic.causalEvents].some((id: string) => {
            const event = eventById.get(id); return event && isOperatingCatalystEvent(event);
          })).length,
        },
        consumerCompanyFunnel: {
          recalled: collected.filter((item) => consumerCompanyPattern.test(referenceText(item)) && operatingCatalystPattern.test(referenceText(item))).length,
          fresh: references.filter((item) => consumerCompanyPattern.test(referenceText(item)) && operatingCatalystPattern.test(referenceText(item))).length,
          events: events.filter(isConsumerCompanyEvent).length,
          audienceQualified: events.filter((event: any) => isConsumerCompanyEvent(event) && hasVerifiedAudienceSignal(event)).length,
          topics: topics.filter((topic) => topic.isConsumerCompany).length,
          qualifiedEvents: events.filter((event: any) => isConsumerCompanyEvent(event) && hasVerifiedAudienceSignal(event)).map((event: any) => ({ title: event.title, entity: specificCompanyEntities(event)[0] || "", ageHours: event.ageHours, sources: event.sourceCount, social: event.socialCount, reaction: event.marketReaction })),
          selectedTopics: topics.filter((topic) => topic.isConsumerCompany).map((topic) => ({ title: topic.title, rank: topic.id, score: topic.score })),
        },
        socialReferenceCount: semanticReferences.filter((item) => item.social).length,
        socialChannels,
        extendedHoursReferenceCount: semanticReferences.filter((item) => /盘前|盘后|premarket|pre-market|after.hours|extended.hours/i.test(`${item.title} ${item.snippet} ${item.query}`)).length,
        unclassifiedEvidenceIds: semantic.unclassifiedEvidenceIds,
        backgroundOrUnverifiedEventCount: excludedBackgroundEvents.length,
        backgroundOrUnverifiedEvents: excludedBackgroundEvents.map((event: any) => ({ title: event.title, occurredAt: event.occurredAt, currentAction: event.currentAction, timeEvidence: event.timeEvidence, timeConfidence: event.timeConfidence })),
      },
      requestIds: batches.map((batch) => batch.requestId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "热点扫描失败。";
    const timedOut = /timeout|timed out|abort/i.test(message) || (error instanceof Error && error.name === "TimeoutError");
    return Response.json({
      error: timedOut ? "热点扫描的外部数据源超过阶段时限，本轮已停止，避免页面无限等待。请稍后重试；已保存的上一次扫描不会被覆盖。" : message,
    }, { status: timedOut ? 504 : 502 });
  }
}
