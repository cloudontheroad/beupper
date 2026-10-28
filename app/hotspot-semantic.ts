import { scanUsage } from "./scan-usage";

export type SemanticReference = {
  traceId: string;
  title: string;
  snippet: string;
  url: string;
  site: string;
  publishedAt: string;
  query: string;
  authoritative: boolean;
  social?: boolean;
};

export type SemanticEvent = {
  eventId: string;
  title: string;
  summary: string;
  occurredAt: string;
  family: string;
  stage: "rumor" | "discussion" | "proposal" | "official" | "implemented" | "market_reaction" | "unknown";
  actors: string[];
  actions: string[];
  objects: string[];
  sectors: string[];
  markets: string[];
  assets: string[];
  transmission: string[];
  evidenceIds: string[];
  marketReaction: number;
  novelty: number;
  confidence: number;
  isCurrentEvent: boolean;
  currentAction: string;
  timeEvidence: string;
  timeConfidence: "high" | "medium" | "low";
};

export type CausalAnalysisTopic = {
  title: string;
  observedEventIds: string[];
  causalEventIds: string[];
  mechanism: string;
  causality: "confirmed" | "strong_hypothesis" | "possible" | "unresolved";
  counterEvidence: string;
  verificationSignals: string[];
  markets: string[];
  marketImportance: number;
  explanatoryPower: number;
  evidenceStrength: number;
  novelty: number;
  confidence: number;
  searchDemand: number;
  stakeholderConflict: number;
  entitySpecificity: number;
  investorProximity: number;
  timelinessOpportunity: number;
  discoveryLane: "search" | "recommendation" | "dual";
};

const extractionSystem = `你是全球财经新闻事件编辑。你的任务不是选题、评分或写观点，而是把搜索结果穷尽地标准化成“今天真实发生的事件全集”。

事件必须是具体的“行动者—动作—对象—时间”或“资产—价格变化—时间”，不能写成“市场关注汇率”“科技板块值得关注”等主题。动态提取所有公司、机构、官员、国家、产品、行业和资产，不依赖预设名单。只要family=corporate，actors必须包含实施动作的具体公司全名或常用名；不得用“消费行业”“市场”“投资者”等泛称代替公司实体，事件标题必须出现该公司名。

严格区分“文章近期发布”和“事情近期发生”。搜索结果发布时间只是文章时间，不能证明文中提到的动作属于当前事件。新闻回顾、背景介绍、旧计划、旧传闻、旧公告被近期文章重新引用时，不得建立为当前事件；把对应evidenceId放入unclassifiedEvidenceIds。只有证据正文明确给出72小时内的新动作、新阶段、新公告、新价格反应或新的官方确认，isCurrentEvent才可为true。像“计划上市、拟上市、已启动上市辅导、曾提交申请”必须结合明确的新日期和新动作；仅仅再次谈到某公司上市，currentAction为空且isCurrentEvent=false。occurredAt必须是事件动作本身的时间，禁止复制文章抓取时间或根据查询中的“今日”猜测。

严格区分 rumor、discussion、proposal、official、implemented、market_reaction；拟议措施不能写成已经实施。不同来源描述同一具体动作时合并；同属一个行业但动作、主体或时间不同，必须拆开。每条有效证据必须分配给一个事件；确实无法判断的证据放入 unclassifiedEvidenceIds，禁止静默丢弃。

社交平台内容只用于识别讨论度、主要分歧、拥挤预期和待核验线索，不能把单个用户观点、未经证实数字或涨跌预测写成事实。与某家公司财报有关的雪球、X/Twitter、Reddit讨论，优先把evidenceId并入对应公司事件；只有讨论本身发生异常扩散且构成独立市场现象时，才建立stage=discussion的事件。公司正式披露与盘前/盘后价格变化是两件事件：前者family=corporate，后者family=market_move，并通过transmission描述先后关系。

行业领袖、头部公司创始人或CEO、重要投资人和政策制定者的最新公开讲话、采访、联名立场或罕见共识，本身可以是独立事件。必须写清“谁在何时说了什么、相对过去新增了什么立场、可能改变哪项行业预期”，不能因为尚无即时股价反应就丢弃；但评论者转述、旧语录翻炒或没有原始出处的标题党仍应进入未分类。多人对同一议题形成一致或明显冲突立场时，应合并为一个共识/分歧事件，并保留各自证据。

只输出JSON对象：{"events":[{"eventId":"临时稳定ID","title":"具体事实标题","summary":"两句事实摘要","occurredAt":"事件动作本身的ISO时间或空字符串","isCurrentEvent":true,"currentAction":"72小时内实际新增的动作","timeEvidence":"支持事件时间的证据原句，不超过60字","timeConfidence":"high|medium|low","family":"market_move|monetary|fiscal_macro|regulation_trade|corporate|industry_supply|capital_flow|geopolitics|credit_risk|commodity_fx_rates|other","stage":"rumor|discussion|proposal|official|implemented|market_reaction|unknown","actors":[],"actions":[],"objects":[],"sectors":[],"markets":[],"assets":[],"transmission":[],"evidenceIds":[],"marketReaction":0,"novelty":0,"confidence":0}],"unclassifiedEvidenceIds":[]}。后三个分数为0到100。保持紧凑：title不超过45字，summary不超过100字，每个数组最多8项，不要重复解释。禁止Markdown、禁止换行缩进、禁止输出未要求字段。`;

const operatingCatalystPattern = /发布会|新品|新车|新机|新产品|售价|定价|预售|订单|锁单|交付|销量|量产|扩产|中标|大客户|召回|停产|延期|同店|翻台率|客流|门店|开店|闭店|店效|入住率|客单价|票房|零售额|提价|促销|折扣|联名|加盟|菜单|渠道|库存|出货|预订|会员|product launch|new model|pricing|preorder|orders|deliveries|sales|production|recall|same.store|comparable sales|store openings?|store closures?|traffic|occupancy|revpar|box office|gmv|average ticket|price increase|promotion|discount|franchise/i;

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function salvageCompleteObjects(text: string) {
  // A length-limited response often contains many valid objects followed by one
  // truncated object. Recover only fully closed objects from known top-level arrays.
  for (const key of ["events", "topics", "companies"]) {
    const keyAt = text.indexOf(`"${key}"`);
    if (keyAt < 0) continue;
    const arrayAt = text.indexOf("[", keyAt);
    if (arrayAt < 0) continue;
    const values: any[] = [];
    let start = -1; let depth = 0; let inString = false; let escaped = false;
    for (let index = arrayAt + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{") { if (depth === 0) start = index; depth += 1; }
      else if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try { values.push(JSON.parse(text.slice(start, index + 1))); } catch {}
          start = -1;
        }
      } else if (char === "]" && depth === 0) break;
    }
    if (values.length) return { [key]: values, unclassifiedEvidenceIds: [] };
  }
  return null;
}

async function deepSeekJson(apiKey: string, messages: any[], stage = "JSON生成") {
  async function requestJson(requestMessages: any[]) {
    let response: Response | null = null;
    let lastNetworkError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const usage = scanUsage.getStore();
        if (usage) { usage.calls += 1; usage.inputCharacters += JSON.stringify(requestMessages).length; }
        response = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(90_000),
          body: JSON.stringify({
            model: "deepseek-v4-flash", messages: requestMessages, thinking: { type: "disabled" },
            response_format: { type: "json_object" }, max_tokens: /规划|查询|日历/.test(stage) ? 3000 : /选题/.test(stage) ? 6500 : 14000,
          }),
        });
        if (response.status < 500) break;
        lastNetworkError = `HTTP ${response.status}`;
      } catch (error) {
        lastNetworkError = error instanceof Error ? error.message : String(error);
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    if (!response) throw new Error(`DeepSeek事件理解网络请求失败：${lastNetworkError || "连接未建立"}`);
    const text = await response.text();
    let payload: any = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    const usage = scanUsage.getStore();
    if (usage && payload.usage) {
      usage.promptTokens += Number(payload.usage.prompt_tokens || 0);
      usage.completionTokens += Number(payload.usage.completion_tokens || 0);
      usage.cachedTokens += Number(payload.usage.prompt_cache_hit_tokens || 0);
    }
    if (!response.ok) throw new Error(`DeepSeek事件标准化失败：${payload.error?.message || text.slice(0, 300) || response.status}`);
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek事件标准化返回空内容");
    return { content, receipt: payload.id || "", model: payload.model || "deepseek-v4-flash" };
  }
  const first = await requestJson(messages);
  try {
    return { data: parseJson(first.content), receipt: first.receipt, model: first.model };
  } catch (error) {
    const repaired = await requestJson([
      { role: "system", content: "你是JSON修复器。只修复结构，禁止扩写、改写或补充字段。保留已完整的对象和evidenceIds；若最后一个对象在字符串中被截断，直接删除该不完整对象并闭合数组与根对象。输出单行紧凑JSON，不解释。" },
      { role: "user", content: first.content },
    ]);
    try {
      return { data: parseJson(repaired.content), receipt: `${first.receipt},${repaired.receipt}`, model: repaired.model };
    } catch (repairError) {
      const salvaged = salvageCompleteObjects(repaired.content) || salvageCompleteObjects(first.content);
      if (salvaged) {
        return { data: salvaged, receipt: `${first.receipt},${repaired.receipt},salvaged`, model: repaired.model };
      }
      throw new Error(`DeepSeek在“${stage}”阶段连续两次返回非法JSON且无完整对象可恢复：首次 ${error instanceof Error ? error.message : String(error)}；修复 ${repairError instanceof Error ? repairError.message : String(repairError)}`);
    }
  }
}

function cleanEvent(raw: any, fallbackId: string): SemanticEvent {
  const list = (value: any) => Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : [];
  const number = (value: any) => Math.max(0, Math.min(100, Number(value) || 0));
  return {
    eventId: String(raw.eventId || fallbackId),
    title: String(raw.title || "未命名财经事件").trim(),
    summary: String(raw.summary || "").trim(),
    occurredAt: String(raw.occurredAt || "").trim(),
    family: String(raw.family || "other"),
    stage: raw.stage || "unknown",
    actors: list(raw.actors), actions: list(raw.actions), objects: list(raw.objects), sectors: list(raw.sectors),
    markets: list(raw.markets), assets: list(raw.assets), transmission: list(raw.transmission), evidenceIds: list(raw.evidenceIds),
    marketReaction: number(raw.marketReaction), novelty: number(raw.novelty), confidence: number(raw.confidence),
    isCurrentEvent: raw.isCurrentEvent === true,
    currentAction: String(raw.currentAction || "").trim(),
    timeEvidence: String(raw.timeEvidence || "").trim(),
    timeConfidence: ["high", "medium", "low"].includes(raw.timeConfidence) ? raw.timeConfidence : "low",
  };
}

export async function standardizeFinancialEvents(apiKey: string, references: SemanticReference[]) {
  const chunks: SemanticReference[][] = [];
  // 20条一批仍能保留足够摘要上下文，同时显著减少串行模型往返次数。
  for (let index = 0; index < references.length; index += 20) chunks.push(references.slice(index, index + 20));
  const extracted: SemanticEvent[] = [];
  const unclassified = new Set<string>();
  const receipts: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const compact = chunks[index].map((item) => ({
      evidenceId: item.traceId, title: item.title, summary: item.snippet.slice(0, 320), site: item.site,
      publishedAt: item.publishedAt, authoritative: item.authoritative, social: Boolean(item.social),
    }));
    const result = await deepSeekJson(apiKey, [
      { role: "system", content: extractionSystem },
      { role: "user", content: `北京时间：${new Date().toISOString()}。标准化第${index + 1}批搜索证据：\n${JSON.stringify(compact)}` },
    ], `事件抽取第${index + 1}批`);
    receipts.push(result.receipt);
    (result.data.events || []).forEach((event: any, eventIndex: number) => extracted.push(cleanEvent(event, `batch-${index + 1}-${eventIndex + 1}`)));
    (result.data.unclassifiedEvidenceIds || []).forEach((id: any) => unclassified.add(String(id)));
  }

  if (extracted.length <= 1) return { events: extracted, unclassifiedEvidenceIds: [...unclassified], receipts };
  const mergeInput = extracted.map((event) => ({ ...event, summary: event.summary.slice(0, 350) }));
  const mergeSystem = `${extractionSystem}\n现在执行跨批次事件合并。只有同一行动者在同一时间针对同一对象实施或讨论同一动作，才能合并。严禁因为同属汇率、芯片、AI、监管或同一国家而合并。保留全部evidenceIds。`;
  const merged = await deepSeekJson(apiKey, [
    { role: "system", content: mergeSystem },
    { role: "user", content: `合并以下候选事件并重新编号：\n${JSON.stringify(mergeInput)}` },
  ], "跨批事件合并");
  receipts.push(merged.receipt);
  const events: SemanticEvent[] = (merged.data.events || []).map((event: any, index: number) => cleanEvent(event, `event-${index + 1}`));
  (merged.data.unclassifiedEvidenceIds || []).forEach((id: any) => unclassified.add(String(id)));
  // Cross-batch merging can silently drop a small corporate catalyst even when
  // Baidu already recalled it. Audit every high-signal product/operating source;
  // uncovered evidence receives a focused recovery pass and cannot disappear just
  // because larger macro events dominated the main merge prompt.
  const coveredIds = new Set(events.flatMap((event) => event.evidenceIds));
  const missingCatalysts = references.filter((item) =>
    operatingCatalystPattern.test(item.query) && operatingCatalystPattern.test(`${item.title} ${item.snippet}`) && !coveredIds.has(item.traceId),
  ).sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)).slice(0, 60);
  if (missingCatalysts.length) {
    for (let index = 0; index < missingCatalysts.length; index += 20) {
      const chunk = missingCatalysts.slice(index, index + 20).map((item) => ({
        evidenceId: item.traceId, title: item.title, summary: item.snippet.slice(0, 500), site: item.site,
        publishedAt: item.publishedAt, query: item.query, authoritative: item.authoritative,
      }));
      const recovered = await deepSeekJson(apiKey, [
        { role: "system", content: `${extractionSystem}\n这是经营催化剂漏失恢复。输入中的新品发布、新车新机、定价、订单、交付、销量、量产、中标、召回或停产，以及消费公司的同店、翻台率、客流、门店开闭、店效、入住率、客单价、票房、提价促销、渠道库存等经营动作，只要正文能证明72小时内发生，就必须建立以具体上市公司为主体的corporate事件；同一公司同一动作可合并，禁止改写成抽象的“消费复苏”或行业主题。文章若同时给出该公司股价反应，应写进transmission和marketReaction。` },
        { role: "user", content: `恢复这些尚未被任何事件认领的经营催化剂证据：${JSON.stringify(chunk)}` },
      ], `经营催化剂恢复第${Math.floor(index / 20) + 1}批`);
      receipts.push(recovered.receipt);
      for (const raw of recovered.data.events || []) {
        const event = cleanEvent(raw, `catalyst-recovery-${events.length + 1}`);
        if (!event.evidenceIds.length) continue;
        events.push(event);
        event.evidenceIds.forEach((id) => unclassified.delete(id));
      }
    }
  }
  return { events, unclassifiedEvidenceIds: [...unclassified], receipts };
}

export async function deriveMarketFollowUpQueries(apiKey: string, references: SemanticReference[]) {
  const actionableReferences = references
    .filter((item) => /收盘|盘前|盘后|close|closed|premarket|after.hours|涨|跌|surge|plunge|rally|selloff|财报|业绩|盈利|指引|公告|披露|earnings|results|guidance|filing|conference call|发布会|新品|新车|新机|新产品|售价|定价|预售|订单|锁单|交付|销量|量产|扩产|中标|召回|停产|product launch|new model|pricing|preorder|orders|deliveries|sales|公开表态|发言|演讲|采访|警告|呼吁|支持|反对|联名|共识|statement|speech|interview|warns?|calls? for|supports?|opposes?|agree|slow down|pause|雪球|twitter|x\.com|reddit|热议|讨论|sentiment/i.test(`${item.title} ${item.snippet} ${item.site} ${item.url}`))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    .slice(0, 45)
    .map((item) => ({ title: item.title, summary: item.snippet.slice(0, 320), publishedAt: item.publishedAt }));
  if (!actionableReferences.length) return { queries: [], receipt: "" };
  const result = await deepSeekJson(apiKey, [
    { role: "system", content: "你是实时财经编辑。输入同时包含最新行情、公司公告、财报日历、上市公司产品与经营动作、关键人物公开表态和社交讨论。生成二次检索：第一类追查指数、行业或个股异动的具体原因；第二类逐一核验日历中今天应发布业绩的重要上市公司；第三类对重要财报公司补齐正式披露与预期差、实时股价与成交、投资者核心分歧；第四类对动态发现的公司经营催化剂补齐官方原文、经营数字及本股反应，尤其不能漏掉消费公司的同店、客流、翻台率、门店、店效、客单价、销量、提价促销、渠道库存；第五类对行业领袖、头部公司创始人或CEO、重要投资人、政策制定者的最新讲话、采访、联名立场或罕见共识，补齐原始讲话/视频/帖文、准确原话语境、其他关键人物的同意或反对，以及行业和相关上市公司的预期变化。没有即时股价变化也要追踪，但旧语录翻炒不得追踪。预告只负责发现主体，绝不能当成已经发生。只追输入中动态出现的实体，不得沿用历史偏好或预设人物名单，不得生成泛泛宏观查询。每个事件最多生成原始出处、交叉验证、市场/行业反应三条功能不同的查询，禁止近义重复。最多15条，互不重复，优先最近24小时。只输出JSON：{\"queries\":[\"...\"]}。每条不超过60个字符。" },
    { role: "user", content: `北京时间${new Date().toISOString()}，最新可追踪证据：${JSON.stringify(actionableReferences)}` },
  ], "行情与经营动作二次查询");
  return { queries: [...new Set((result.data.queries || []).map(String).map((item: string) => item.trim()).filter(Boolean))].slice(0, 15), receipt: result.receipt };
}

export async function planScanFollowUps(apiKey: string, references: SemanticReference[]) {
  if (!references.length) return { queries: [] as string[], companies: [] as any[], receipt: "" };
  const compact = references.map((item) => ({ id: item.traceId, title: item.title, summary: item.snippet.slice(0, 320), date: item.publishedAt,
    calendar: /财报日历|业绩发布时间|earnings calendar|reporting before open|after close/i.test(item.query) }));
  const result = await deepSeekJson(apiKey, [
    { role: "system", content: "你是实时财经补证编辑。输入已去重。一次完成今日财报公司提取和事件补查规划。只追输入出现的实体，禁止历史公司名单。日历需核对实际披露日，预告不能当正式发布。覆盖美股/A股/港股行情原因、财报与产品经营动作（包括消费同店客流门店）、监管贸易与关键人物新表态。逐事件检查原文、独立交叉验证、本股反应和投资者观点：已有充分材料不再查，只针对缺口生成查询。同一事件最多两条功能不同的补查，不复述原查询，不生成泛宏观查询。兼顾不同市场和事件类型，不按公司名气筛掉消费与经营事件。最多18条查询、6家今日财报公司。每条查询不超过70字符。JSON紧凑输出：{\"queries\":[\"...\"],\"companies\":[{\"name\":\"...\",\"ticker\":\"...\",\"market\":\"...\"}]}。" },
    { role: "user", content: `当前UTC时间${new Date().toISOString()}，北京时间UTC+8。证据：${JSON.stringify(compact)}` },
  ], "统一缺口补查规划");
  return {
    queries: [...new Set<string>((result.data.queries || []).map(String).map((q: string) => q.trim()).filter(Boolean))].slice(0, 18),
    companies: Array.isArray(result.data.companies) ? result.data.companies.slice(0, 6) : [], receipt: result.receipt,
  };
}

export async function deriveCorporateReleaseFollowUpQueries(apiKey: string, references: SemanticReference[]) {
  const calendarEvidence = references
    .filter((item) => /财报日历|业绩发布时间|earnings calendar|reporting before open|after close/i.test(`${item.query} ${item.title} ${item.snippet}`))
    .slice(0, 30)
    .map((item) => ({ title: item.title, summary: item.snippet.slice(0, 500), publishedAt: item.publishedAt, site: item.site }));
  if (!calendarEvidence.length) return { queries: [], companies: [], receipt: "" };
  const result = await deepSeekJson(apiKey, [
    { role: "system", content: "你是上市公司财报日历编辑。只从输入证据中提取按北京时间今天计划发布或已经发布财报的重要上市公司，不得补充记忆中的公司。日历页面可以提前发布，判断对象是页面所写的财报发布日期。公司去重，优先大型公司、热门股票、中概股及对A股港股有映射的公司，最多6家。只输出JSON：{\"companies\":[{\"name\":\"公司常用中文或英文名\",\"ticker\":\"股票代码或空\",\"market\":\"市场或空\"}]}。" },
    { role: "user", content: `北京时间${new Date().toISOString()}。从这些日历证据提取今日财报公司：${JSON.stringify(calendarEvidence)}` },
  ], "财报日历实体提取");
  const companies = (result.data.companies || [])
    .map((item: any) => ({ name: String(item.name || "").trim(), ticker: String(item.ticker || "").trim(), market: String(item.market || "").trim() }))
    .filter((item: any) => item.name)
    .filter((item: any, index: number, list: any[]) => list.findIndex((other: any) => `${other.name}|${other.ticker}`.toLowerCase() === `${item.name}|${item.ticker}`.toLowerCase()) === index)
    .slice(0, 6);
  const queries = companies.flatMap((company: any) => {
    const entity = `${company.name} ${company.ticker}`.trim();
    return [
      `${entity} 今日最新财报 正式公告 实际值 市场预期 指引`,
      `${entity} 财报后 盘前盘后 股价涨跌 成交量 premarket after hours`,
      `${entity} 财报 雪球 X Twitter 投资者讨论 分歧`,
    ];
  });
  return { queries: [...new Set(queries)].slice(0, 18), companies, receipt: result.receipt };
}

export async function buildCausalAnalysisTopics(apiKey: string, events: any[], strategyProfile: any = {}, stableTopicSkill = "", supplement = false) {
  if (!events.length) return { topics: [], receipt: "" };
  const compactEvents = events.slice(0, 60).map((event) => ({
    eventId: event.id || event.eventId, title: event.title, summary: event.summary || event.thesis,
    occurredAt: event.occurredAt, family: event.family, stage: event.stage, actors: event.actors,
    actions: event.actions, objects: event.objects, sectors: event.sectors, markets: event.markets,
    assets: event.assets, transmission: event.transmission, marketReaction: event.marketReaction,
    sourceCount: event.sourceCount, authorityCount: event.authorityCount, socialCount: event.socialCount, rank: event.rank,
    eventScore: event.score, ageHours: event.ageHours,
  }));
  const system = `你是全球资本市场因果分析编辑。输入是已经标准化的今日事件全集。请把“行情事实”和“原因事件”连接成适合深度视频的分析型选题，而不是重新罗列新闻。

先识别 observed events：指数、行业、公司、债券、汇率或商品的实际价格与资金变化；再识别 causal events：政策监管、财报指引、利率流动性、产业供需、资本流向、地缘冲击等。只有满足时间顺序合理、影响对象匹配、存在清晰传导机制时才能连接。一个监管事件可能解释某个细分板块，不得擅自解释整个大盘；相关性不能写成已确认因果。跨市场比较必须对齐指数全名、交易日、当地时区、涨跌区间和信息截点；非重叠交易时段的反向行情只能作为待解释异常，不得当成同一消息的同步反应。

优先形成“明确实体 + 当天新动作 + 价格或利益冲击 + 具体原因 + 可验证机制”的选题。没有充分根因的重大行情保留为 unresolved；没有明显行情但影响重大的原因事件必须形成可独立成立的分析题，不能因为暂时缺少股价反应而从选题池消失。事件榜前8名必须各自出现在至少一个题目的 observedEventIds 或 causalEventIds 中；一个题可以覆盖确有因果关系的多个事件，但禁止为了完成覆盖而虚构联系。禁止给任何特定国家、汇率、行业或用户曾提及事件固定加权。

行业关键人物的公开表态不是娱乐八卦。若多位具备真实决策权或资本配置权的人对技术路线、监管、资本开支、风险边界形成罕见共识或冲突，应把它作为“预期变化的领先信号”构造选题：解释他们为何此时表态、各自利益与约束是否一致、会先改变融资/资本开支/监管概率/估值中的哪一项，以及用什么后续动作验证。不得把名气本身当重要性，也不得要求先有股价异动才入选。

同时判断两条互不替代的传播通道：search 代表用户会主动搜索准确公司、资产、公告动作或异动数字；recommendation 代表即使用户没搜索，也能立刻理解反常价格、谁获益谁承担成本的冲突；两者都强才是 dual。searchDemand必须基于证据中的当日新动作、明确搜索实体、数字冲击和讨论扩散，不得因公司知名度凭空给高分。stakeholderConflict衡量“谁在买卖、谁获益、谁承担稀释/成本/风险”是否具体；entitySpecificity衡量标题能否落到不可替换的公司、资产或政策动作；investorProximity衡量公司是否被个人投资者真实关注、产品或业务是否可感知、事件是否直接改变本股盈利/估值、社区是否有真实分歧。知名度、市值和品牌曝光不能单独构成高分；timelinessOpportunity衡量现在发布是否仍处于盘前、盘后、财报、IPO、配售、监管、停牌或剧烈异动的搜索窗口。

只输出JSON：{"topics":[{"title":"具体分析命题","observedEventIds":[],"causalEventIds":[],"mechanism":"原因如何传到价格，不超过120字","causality":"confirmed|strong_hypothesis|possible|unresolved","counterEvidence":"最强反证，不超过80字","verificationSignals":[],"markets":[],"marketImportance":0,"explanatoryPower":0,"evidenceStrength":0,"novelty":0,"confidence":0,"searchDemand":0,"stakeholderConflict":0,"entitySpecificity":0,"investorProximity":0,"timelinessOpportunity":0,"discoveryLane":"search|recommendation|dual"}]}。所有分数0到100，最多输出18个互不重复的分析命题。`;
  const result = await deepSeekJson(apiKey, [
    { role: "system", content: `${system}\n公司财报、业绩预告、经营指引、资本开支，以及新品发布、定价、订单、交付、销量、量产、扩产、中标、召回或停产，都是公司定价事件。消费公司的同店、翻台率、客流、门店开闭、店效、入住率、客单价、票房、提价促销、渠道库存和会员变化也属于公司定价事件，不得被吞进抽象的“消费复苏”。只要事件明确指向一家上市公司，首要选题必须围绕该公司本股：市场原来定价了什么、新动作改变了收入/毛利/需求/竞争的哪项预期、发布前后股价与资金如何反应、价格是否充分反映、后续由哪些经营数字验证。行业、供应链和跨市场外溢只能作为第二层影响，不能取代本股成为标题和核心机制。只有证据显示多家公司同步变化、行业盈利预测被普遍上修或下修时，才可以另建行业级选题。不得因为公司规模大，就自动把单家公司事件改写成行业趋势。\n\n以下是当前稳定选题Skill：${stableTopicSkill}\n\n以下是抖音真实数据形成的最新选题策略，只能在事实、时效和证据硬门之后影响选题构造与排序倾向，不能创造新闻或覆盖事件重要性：${JSON.stringify(strategyProfile?.topicDirectives || [])}` },
    { role: "user", content: `当前UTC时间${new Date().toISOString()}。${supplement ? "这是未覆盖事件的一次集中补充。每个输入事件各生成一个具体分析题，必须链接该事件ID；公司题标题必须包含对应公司实体。证据不足以构成分析的事件可以不输出，禁止用通用问句凑数。" : "从事件全集构建因果分析型选题。"}标题要围绕本事件的具体经营变量、预期差或利益冲突，不得拼接“本股估值要重算吗”“行情还能延续吗”“市场在重估什么”等可替换后缀。输入：${JSON.stringify(compactEvents)}` },
  ], "因果分析选题生成");
  const list = (value: any) => Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
  const number = (value: any) => Math.max(0, Math.min(100, Number(value) || 0));
  const topics: CausalAnalysisTopic[] = (result.data.topics || []).map((item: any) => ({
    title: String(item.title || "未命名分析题").trim(), observedEventIds: list(item.observedEventIds), causalEventIds: list(item.causalEventIds),
    mechanism: String(item.mechanism || "").trim(), causality: item.causality || "unresolved",
    counterEvidence: String(item.counterEvidence || "").trim(), verificationSignals: list(item.verificationSignals), markets: list(item.markets),
    marketImportance: number(item.marketImportance), explanatoryPower: number(item.explanatoryPower), evidenceStrength: number(item.evidenceStrength),
    novelty: number(item.novelty), confidence: number(item.confidence),
    searchDemand: number(item.searchDemand), stakeholderConflict: number(item.stakeholderConflict),
    entitySpecificity: number(item.entitySpecificity), investorProximity: number(item.investorProximity), timelinessOpportunity: number(item.timelinessOpportunity),
    discoveryLane: ["search", "recommendation", "dual"].includes(item.discoveryLane) ? item.discoveryLane : "recommendation",
  }));
  return { topics, receipt: result.receipt };
}

export function scoreCausalAnalysisTopic(topic: CausalAnalysisTopic, freshness = 0) {
  const causalDepth = topic.causalEventIds.length && topic.mechanism ? topic.explanatoryPower : topic.explanatoryPower * 0.45;
  const causalityFactor = topic.causality === "confirmed" ? 100 : topic.causality === "strong_hypothesis" ? 82 : topic.causality === "possible" ? 60 : 38;
  return Math.round(
    causalDepth * 0.15 + topic.marketImportance * 0.13 + topic.evidenceStrength * 0.13 +
    topic.novelty * 0.04 + causalityFactor * 0.05 + topic.confidence * 0.03 + freshness * 0.12 +
    topic.searchDemand * 0.10 + topic.stakeholderConflict * 0.08 + topic.entitySpecificity * 0.05 +
    topic.investorProximity * 0.08 + topic.timelinessOpportunity * 0.04,
  );
}

export function scoreSemanticEvent(event: SemanticEvent, evidence: SemanticReference[]) {
  const sources = new Set(evidence.map((item) => item.site || item.url).filter(Boolean));
  const authorityCount = evidence.filter((item) => item.authoritative).length;
  const occurredAt = Date.parse(event.occurredAt || "");
  const fallbackTimes = evidence.map((item) => Date.parse(item.publishedAt)).filter(Number.isFinite);
  const timestamp = Number.isFinite(occurredAt) ? occurredAt : Math.max(...fallbackTimes, Date.now() - 72 * 3_600_000);
  const ageHours = Math.max(0, (Date.now() - timestamp) / 3_600_000);
  const freshness = ageHours <= 2 ? 100 : ageHours <= 8 ? 94 : ageHours <= 24 ? 70 : ageHours <= 48 ? 28 : 0;
  const evidenceQuality = Math.min(100, sources.size * 18 + authorityCount * 16 + event.confidence * 0.35);
  const breadth = Math.min(100, event.markets.length * 18 + event.sectors.length * 10 + event.assets.length * 7);
  const score = Math.round(
    freshness * 0.34 + event.marketReaction * 0.19 + evidenceQuality * 0.18 +
    event.novelty * 0.14 + breadth * 0.09 + event.confidence * 0.06,
  );
  const warnings: string[] = [];
  if (sources.size < 2) warnings.push("独立来源少于2个");
  if (!authorityCount) warnings.push("缺少一级或权威信源");
  if (event.confidence < 60) warnings.push("事件理解置信度偏低");
  if (!event.markets.length && !event.assets.length) warnings.push("尚未识别具体资产映射");
  return { score, ageHours: Math.round(ageHours * 10) / 10, sourceCount: sources.size, authorityCount, warnings };
}
