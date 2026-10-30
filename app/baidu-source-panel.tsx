"use client";

import { useEffect, useState } from "react";
import { apiUrl, readJsonResponse } from "./api-client";
import { abstractStrategyProfile } from "./strategy-profile";
import { loadScanCache, saveScanCache } from "./scan-cache";

const hotspotPipelineVersion = "multi-source-efficient-v10";

function sourceUrlFor(item: any) {
  const candidate = item?.evidence?.find((entry: any) => entry?.url)?.url;
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function BaiduSourcePanel({ notify, onValidated, onScan }: { notify: (message: string) => void; onValidated: (value: boolean) => void; onScan: (scan: any) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [searchProvider, setSearchProvider] = useState<"baidu" | "deepseek">("baidu");
  const sourceName = searchProvider === "deepseek" ? "DeepSeek Search" : "百度 WebSearch";
  const [socialStatus, setSocialStatus] = useState<any>(null);
  const [validated, setValidated] = useState(false);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [scan, setScan] = useState<any>(null);
  const [scanStale, setScanStale] = useState(false);
  const [scanWaitSeconds, setScanWaitSeconds] = useState(0);

  useEffect(() => {
    if (loading !== "scan") { setScanWaitSeconds(0); return; }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setScanWaitSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    setApiKey(window.localStorage.getItem("financial-titan-baidu-key") || "");
    setDeepseekApiKey(window.localStorage.getItem("financial-titan-deepseek-key") || "");
    const savedProvider = window.localStorage.getItem("financial-titan-search-provider") === "deepseek" ? "deepseek" : "baidu";
    setSearchProvider(savedProvider);
    const ok = window.localStorage.getItem(`financial-titan-${savedProvider}-validated`) === "true";
    setValidated(ok);
    onValidated(ok);
    let cancelled = false;
    loadScanCache().then((parsed) => {
      if (cancelled || !parsed) return;
      if (parsed.pipelineVersion !== hotspotPipelineVersion || parsed.searchProvider !== savedProvider) return;
      const ageMs = Date.now() - new Date(parsed.scannedAt || 0).getTime();
      const stale = !parsed.scannedAt || ageMs > 90 * 60 * 1000;
      setScan(parsed);
      setScanStale(stale);
      if (!stale) onScan(parsed);
    }).catch(() => { /* Scanning remains available if browser storage is disabled. */ });
    return () => { cancelled = true; };
  }, [onValidated, onScan]);

  useEffect(() => {
    if (apiKey) window.localStorage.setItem("financial-titan-baidu-key", apiKey);
  }, [apiKey]);

  useEffect(() => {
    if (deepseekApiKey) window.localStorage.setItem("financial-titan-deepseek-key", deepseekApiKey);
  }, [deepseekApiKey]);

  async function socialLogin(platform: "xueqiu" | "twitter", action: "start" | "status") {
    setLoading(`${platform}-${action}`); setError("");
    try {
      const response = await fetch(apiUrl("/api/social-login"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, action }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "社交登录操作失败");
      if (action === "start") notify(payload.message || "登录窗口已打开");
      else {
        setSocialStatus((current: any) => ({ ...(current || {}), [platform]: payload }));
        notify(payload.loggedIn && payload.searchReady !== false
          ? `${platform === "xueqiu" ? "雪球" : "X"}已检测到可用登录会话`
          : (payload.message || payload.error || `${platform === "xueqiu" ? "雪球" : "X"}尚未检测到登录`));
      }
    } catch (error) { setError(error instanceof Error ? error.message : "社交登录操作失败"); }
    finally { setLoading(""); }
  }

  async function call(action: "test" | "scan") {
    setLoading(action);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/baidu-websearch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: searchProvider === "baidu" ? apiKey : undefined, deepseekApiKey, searchProvider, action,
          strategyProfile: abstractStrategyProfile(JSON.parse(window.localStorage.getItem("financial-titan-strategy-profile") || "{}")),
        }),
        signal: AbortSignal.timeout(action === "scan" ? 900_000 : 40_000),
      });
      const payload = await readJsonResponse(response, sourceName);
      if (!response.ok || !payload.ok) throw new Error(payload.error || `${sourceName}搜索请求失败`);
      if (action === "test") {
        setValidated(true);
        onValidated(true);
        window.localStorage.setItem(`financial-titan-${searchProvider}-validated`, "true");
        notify(`${sourceName}验证成功，返回 ${payload.resultCount} 条结果`);
      } else {
        setScan(payload);
        setScanStale(false);
        onScan(payload);
        try { await saveScanCache(payload); }
        catch (storageError) {
          setError(`本轮扫描已完成，可继续选题，但缓存保存失败，刷新后可能丢失本轮结果：${storageError instanceof Error ? storageError.message : String(storageError)}`);
          notify("扫描完成，但未能持久保存；请先使用本轮结果，不要刷新页面");
          return;
        }
        notify(`今日扫描完成，形成 ${payload.topics.length} 个有效候选，其中 ${payload.mainTopicCount} 个达到主推门槛`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接失败";
      setError(/timeout|timed out|abort/i.test(message) ? "本轮扫描已超过15分钟并停止，旧扫描结果仍保留。请检查失败查询与网络状态后重试。" : message);
      if (action === "test") {
        setValidated(false);
        onValidated(false);
        window.localStorage.removeItem(`financial-titan-${searchProvider}-validated`);
      }
    } finally {
      setLoading("");
    }
  }

  return (
    <section className="card baiduSource">
      <div className="baiduHead">
        <div><p className="eyebrow">LIVE DATA SOURCE</p><h2>热点搜索与分析</h2></div>
        <span className={validated ? "sourceOk" : "sourcePending"}>{validated ? "已验证" : "待验证"}</span>
      </div>
      <div className="sourceConfig">
        {searchProvider === "baidu" && <label>百度 API Key<input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setValidated(false); onValidated(false); window.localStorage.removeItem("financial-titan-baidu-validated"); }} placeholder="仅保存在当前浏览器" autoComplete="off" /></label>}
        <label>DeepSeek Key<input type="password" value={deepseekApiKey} onChange={(event) => { setDeepseekApiKey(event.target.value); if (searchProvider === "deepseek") { setValidated(false); onValidated(false); } window.localStorage.removeItem("financial-titan-deepseek-validated"); }} placeholder={searchProvider === "deepseek" ? "同时用于搜索和热点分析" : "用于热点分析"} autoComplete="off" /></label>
        <button className="ghost" disabled={!(searchProvider === "deepseek" ? deepseekApiKey : apiKey) || Boolean(loading)} onClick={() => call("test")}>{loading === "test" ? "验证中…" : "验证连接"}</button>
        <label>搜索数据源<select className="searchProviderSelect" aria-label="搜索数据源" value={searchProvider} disabled={Boolean(loading)} onChange={(event) => {
          const value = event.target.value as "baidu" | "deepseek"; setSearchProvider(value);
          window.localStorage.setItem("financial-titan-search-provider", value);
          const ok = window.localStorage.getItem(`financial-titan-${value}-validated`) === "true";
          setValidated(ok); onValidated(ok);
        }}><option value="baidu">百度 Search API</option><option value="deepseek">DeepSeek Search API</option></select></label>
        <button className="primary" disabled={!validated || !deepseekApiKey || Boolean(loading)} onClick={() => call("scan")}>{loading === "scan" ? `正在召回并标准化 · ${scanWaitSeconds}秒` : "扫描今日热点"}</button>
      </div>
      <p className="credentialHint">{searchProvider === "deepseek" ? "DeepSeek Search 与热点分析共用上方 Key。搜索后统一去重、按证据缺口补查，再分析排序；来源严格核验72小时时效。" : "百度千帆 V2 Key 请填写完整 bce-v3/...；DeepSeek Key 用于事件理解和分析。"}</p>
      <details className="socialSourceConfig" open>
        <summary>雪球与 X/Twitter 直连（Agent-Reach 方法）</summary>
        <div className="socialLoginRows">
          <div><span><b>雪球</b><small>{socialStatus?.xueqiu?.loggedIn && socialStatus?.xueqiu?.searchReady !== false ? "专用浏览器会话已登录，可搜索" : socialStatus?.xueqiu?.message || "尚未检查"}</small></span><button className="ghost" disabled={Boolean(loading)} onClick={() => socialLogin("xueqiu", "start")}>打开浏览器登录</button><button className="ghost" disabled={Boolean(loading)} onClick={() => socialLogin("xueqiu", "status")}>{loading === "xueqiu-status" ? "检测中…" : "检查状态"}</button></div>
          <div><span><b>X / Twitter</b><small>{socialStatus?.twitter?.loggedIn ? "专用浏览器会话已登录" : socialStatus?.twitter?.message || "尚未检查"}</small></span><button className="ghost" disabled={Boolean(loading)} onClick={() => socialLogin("twitter", "start")}>打开浏览器登录</button><button className="ghost" disabled={Boolean(loading)} onClick={() => socialLogin("twitter", "status")}>{loading === "twitter-status" ? "检测中…" : "检查状态"}</button></div>
        </div>
        <p className="credentialHint">点击后会打开项目专属浏览器窗口。正常登录后可直接点“检查状态”，窗口无需关闭。系统不会读取你日常浏览器的账号资料；后续只复用这个专用会话做只读搜索。</p>
      </details>
      {error && <p className="coverError">{error}</p>}
      <div className="sourceMethod"><span>① 通用财经覆盖矩阵</span><span>② 动态实体与动作提取</span><span>③ 事件级语义标准化</span><span>④ 全链路诊断与纯排序</span></div>
      {scan && (
        <div className="liveEvidence">
          <div><b>{scanStale ? "历史扫描（已过期）" : "最近扫描"}：{new Date(scan.scannedAt).toLocaleString("zh-CN")}</b><span>{scan.queryCount} 组查询{scan.followUpQueryCount ? `（含 ${scan.followUpQueryCount} 组行情追因/公告追踪）` : ""} · 搜索返回 {scan.collectedReferenceCount ?? scan.rawReferenceCount ?? scan.references.length} 条 → 72小时有效 {scan.rawReferenceCount ?? scan.references.length} 条 → 内容去重 {scan.contentDedupCount ?? scan.references.length} 条 · {scan.events?.length ?? scan.discoveredEventCount ?? "—"} 个独立事件 · {scan.topics.length} 个头部候选</span></div>
          {scanStale && <p className="coverError">这份结果已超过90分钟，只用于历史查看，不再作为首页“今日热点”。请重新扫描以获取最新交易时段信息。</p>}
          {scan.categoryCoverage?.length > 0 && <div className="coverageTags">覆盖：{scan.categoryCoverage.map((item: string) => <span key={item}>{item}</span>)}</div>}
          {scan.diagnostics?.freshnessBuckets && <div className="coverageTags">时效：<span>2小时突发 {scan.diagnostics.freshnessBuckets.breaking_2h || 0}</span><span>8小时交易时段 {scan.diagnostics.freshnessBuckets.current_session_8h || 0}</span><span>24小时今日 {scan.diagnostics.freshnessBuckets.today_24h || 0}</span><span>24—48小时 {scan.diagnostics.freshnessBuckets.background_48h || 0}</span><span>48—72小时 {scan.diagnostics.freshnessBuckets.background_72h || 0}</span><span>超时来源已隐藏 {scan.timeFilteredOut || 0}</span></div>}
          {scan.diagnostics?.efficiency && <div className="coverageTags">本轮效率：<span>{scan.searchProvider === "deepseek" ? "DeepSeek Search" : "百度搜索"}</span><span>规划前去重 {scan.diagnostics.efficiency.planningRawReferences} → {scan.diagnostics.efficiency.planningUniqueReferences}</span><span>模型请求 {scan.diagnostics.efficiency.modelUsage?.calls || 0}</span><span>输入 {(scan.diagnostics.efficiency.modelUsage?.promptTokens || 0).toLocaleString()} tokens</span><span>输出 {(scan.diagnostics.efficiency.modelUsage?.completionTokens || 0).toLocaleString()} tokens</span><span>缓存命中 {(scan.diagnostics.efficiency.modelUsage?.cachedTokens || 0).toLocaleString()} tokens</span></div>}
          {scan.diagnostics && <div className="coverageTags">公司催化剂：<span>日历发现 {scan.diagnostics.calendarSeedCount || 0}</span><span>8小时内正式财报 {scan.diagnostics.recentCorporateEventCount || 0}</span><span>24小时内产品/经营动作 {scan.diagnostics.recentOperatingCatalystEventCount || 0}</span><span>盘前/盘后证据 {scan.diagnostics.extendedHoursReferenceCount || 0}</span><span>雪球/X等讨论 {scan.diagnostics.socialReferenceCount || 0}</span><span>实体核验查询 {scan.followUpQueryCount || 0}</span><span>旧闻/时间未核验排除 {scan.diagnostics.backgroundOrUnverifiedEventCount || 0}</span></div>}
          {scan.diagnostics?.operatingCatalystFunnel && <div className="coverageTags">经营事件漏斗：<span>原始召回 {scan.diagnostics.operatingCatalystFunnel.recalled || 0}</span><span>72小时有效并去重 {scan.diagnostics.operatingCatalystFunnel.fresh || 0}</span><span>标准化事件 {scan.diagnostics.operatingCatalystFunnel.events || 0}</span><span>高潜选题 {scan.diagnostics.operatingCatalystFunnel.topics || 0}</span></div>}
          {scan.diagnostics?.consumerCompanyFunnel && <div className="coverageTags">消费个股漏斗：<span>原始召回 {scan.diagnostics.consumerCompanyFunnel.recalled || 0}</span><span>72小时有效并去重 {scan.diagnostics.consumerCompanyFunnel.fresh || 0}</span><span>标准化事件 {scan.diagnostics.consumerCompanyFunnel.events || 0}</span><span>真实声量合格 {scan.diagnostics.consumerCompanyFunnel.audienceQualified || 0}</span><span>高潜选题 {scan.diagnostics.consumerCompanyFunnel.topics || 0}</span></div>}
          {scan.diagnostics?.consumerCompanyFunnel?.qualifiedEvents?.length > 0 && <div className="coverageTags">合格消费事件：{scan.diagnostics.consumerCompanyFunnel.qualifiedEvents.map((item: any, index: number) => <span key={`${item.title}-${index}`}>{item.entity ? `${item.entity} · ` : ""}{item.title}</span>)}</div>}
          {scan.diagnostics?.consumerCompanyFunnel?.selectedTopics?.length > 0 && <div className="coverageTags">消费选题落位：{scan.diagnostics.consumerCompanyFunnel.selectedTopics.map((item: any) => <span key={`${item.rank}-${item.title}`}>#{item.rank} {item.title}</span>)}</div>}
          {scan.diagnostics?.topicCompletion?.pending?.length > 0 && <div className="coverageTags">已发现、待补分析：{scan.diagnostics.topicCompletion.pending.map((item: any) => <span key={item.id}>{item.title}</span>)}</div>}
          {scan.diagnostics?.topicCompletion?.error && <p className="keyNotice">选题补充未完成，已有选题保留：{scan.diagnostics.topicCompletion.error}</p>}
          {scan.diagnostics && <div className="coverageTags">组合质量：<span>有真实声量事件 {scan.diagnostics.audienceQualifiedEventCount || 0}</span><span>合格美股候选 {scan.diagnostics.usCandidateCount || 0}</span><span>高潜池美股 {scan.diagnostics.usSelectedCount || 0}</span></div>}
          {scan.diagnostics?.socialChannels && <div className="coverageTags">社交直连：<span>雪球 {scan.diagnostics.socialChannels.xueqiu?.ok ? `${scan.diagnostics.socialChannels.xueqiu.count}条` : scan.diagnostics.socialChannels.xueqiu?.error || "失败"}</span><span>X {scan.diagnostics.socialChannels.twitter?.ok ? `${scan.diagnostics.socialChannels.twitter.count}条` : scan.diagnostics.socialChannels.twitter?.error || "失败"}</span></div>}
          {scan.diagnostics?.corporateCalendarCompanies?.length > 0 && <div className="coverageTags">今日财报实体：{scan.diagnostics.corporateCalendarCompanies.map((item: any) => <span key={`${item.name}-${item.ticker}`}>{item.name}{item.ticker ? ` · ${item.ticker}` : ""}</span>)}</div>}
          {scan.events?.length > 0 && <div className="rejectionDesk">
            <div className="rejectionHead"><b>今日扫描事件全集</b><span>每一行是一个去重后的事件；高潜选题是其中的头部子集</span></div>
            <div className="rejectionTable"><div className="rejectionRow rejectionHeader"><span># / 事件</span><span>类别</span><span>来源/权威/市场</span><span>分数</span><span>排序状态与诊断</span></div>
              {scan.events.map((item: any) => {
                const sourceUrl = sourceUrlFor(item);
                return <div className="rejectionRow" key={item.eventKey || item.id}>
                  <span className="eventTitle" title={item.trigger}>{sourceUrl ? <a className="eventSourceLink" href={sourceUrl} target="_blank" rel="noopener noreferrer"><b className="eventRank">{item.rank}. </b>{item.title}<i>↗</i></a> : <><b className="eventRank">{item.rank}. </b>{item.title}</>}</span>
                  <span className="eventCategory">{item.eventRole || "事件"} · {item.category || "市场事件"} · {item.freshness}</span>
                  <span className="eventSources" aria-label="来源、权威来源、涉及市场数量"><i>来源</i>{item.sourceCount}<i>权威</i>{item.authorityCount}<i>市场</i>{item.markets?.length || 0}</span>
                  <span className="eventScore"><i>综合分</i><b>{Math.round(item.score)}</b></span>
                  <span className={`eventStatus ${item.rejectionReasons?.length ? "rejectionReason" : "eventEligible"}`}><b>{item.status}</b>{item.topicCount ? ` · 对应 ${item.topicCount} 个高潜题` : item.rejectionReasons?.length ? ` · ${item.rejectionReasons.join("；")}` : " · 仅保留在事件全集"}</span>
                </div>;
              })}
            </div>
          </div>}
          {scan.diagnostics && <details className="recallAudit">
            <summary>查看召回全过程诊断</summary>
            <div className="auditCounts">{Object.entries(scan.diagnostics.counts || {}).map(([key, value]) => <span key={key}><b>{String(value)}</b>{key}</span>)}</div>
            <div className="auditTrace"><div className="auditTraceRow auditTraceHead"><span>原始结果</span><span>发布时间</span><span>处理状态</span><span>归属事件</span></div>
              {(scan.diagnostics.traces || []).map((trace: any) => <div className="auditTraceRow" key={trace.traceId}><span>{trace.url ? <a href={trace.url} target="_blank" rel="noopener noreferrer">{trace.title || trace.url}</a> : trace.title}</span><span>{trace.publishedAt || "无时间"}</span><span>{trace.status}</span><span>{trace.eventId || "—"}</span></div>)}
            </div>
          </details>}
        </div>
      )}
      <p className="keyNotice">事件全集不再经过评分淘汰：时间过滤与内容去重后，每条证据必须被动态分配到具体事件或进入“未分类”诊断；评分只决定事件排名和前六个高潜子集。</p>
    </section>
  );
}
