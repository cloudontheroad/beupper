"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { topicEngineRules } from "./topic-engine";
import { CreatorWorkflow } from "./creator-workflow";
import { BaiduSourcePanel } from "./baidu-source-panel";
import { ProjectLibrary } from "./project-library";
import { StrategyIterationPanel } from "./strategy-iteration-panel";
import MobileApp from "./mobile/mobile-app";
import { diagnoseDouyinPerformance, douyinPerformanceBaseline, median } from "./douyin-performance-baseline";

type Topic = {
  id: number;
  title: string;
  thesis: string;
  markets: string[];
  heat: number;
  fit: number;
  depth: number;
  score: number;
  status: string;
  accent: string;
  freshness: string;
  trigger: string;
  category?: string;
  gates?: Record<string, boolean>;
  sourceCount?: number;
  authorityCount?: number;
  socialCount?: number;
  investorProximity?: number;
  evidence?: { title: string; url: string; site?: string; score: number }[];
};

const demoTopics: Topic[] = [
  {
    id: 1,
    title: "昨夜美股AI链暴力反弹，今天A股科技跟涨：反转来了，还是又一次诱多？",
    thesis: "微软单日大涨15.5%、泛林集团涨18%，纳指反弹2.8%；A股白天接力，真正要判断的是“业绩验证”还是“超跌回补”。",
    markets: ["美股", "港股", "A股"],
    heat: 99,
    fit: 99,
    depth: 94,
    score: 98,
    status: "立即做",
    accent: "violet",
    freshness: "11 小时内",
    trigger: "美股收盘 → A股盘中验证",
  },
  {
    id: 2,
    title: "微软证明AI能赚钱，Meta却因加码投入承压：市场到底在奖励什么？",
    thesis: "同样是AI资本开支，一家公司创近18年最佳单日，另一家却被市场惩罚；分水岭是回报兑现速度。",
    markets: ["美股", "港股"],
    heat: 93,
    fit: 90,
    depth: 88,
    score: 91,
    status: "备选",
    accent: "blue",
    freshness: "昨夜财报",
    trigger: "微软 / Meta 财报分化",
  },
  {
    id: 3,
    title: "半导体一个月暴跌后突然反包：为什么“涨得最猛”不等于“风险解除”？",
    thesis: "费城半导体此前从高位深度回撤，昨夜反弹更像财报催化下的空头回补；要看成交、扩散与后续财报确认。",
    markets: ["美股", "A股"],
    heat: 91,
    fit: 95,
    depth: 96,
    score: 94,
    status: "观察",
    accent: "amber",
    freshness: "24 小时内",
    trigger: "超跌反弹 / 趋势反转之争",
  },
];

const pipeline = [
  { label: "热点采集", status: "待接入", done: false },
  { label: "候选评分", status: "规则可用", done: true },
  { label: "选题确认", status: "可使用", done: true },
  { label: "深度研究", status: "可使用", done: true },
  { label: "包装确认", status: "可使用", done: true },
  { label: "口播成稿", status: "可使用", done: true },
  { label: "花生成片", status: "人工交接", done: false },
];

function mergeDouyinReviews(liveReviews: any[]) {
  const normalize = (value: string) => String(value || "").toLowerCase().replace(/#[^\s]+/g, "").replace(/[\s\p{P}\p{S}]/gu, "");
  const rows = new Map<string, any>();
  for (const item of [...douyinPerformanceBaseline, ...liveReviews]) {
    const key = `${normalize(item.title)}|${String(item.publishedAt || "").slice(0, 10)}`;
    const existing = rows.get(key);
    rows.set(key, existing ? { ...existing, ...item, id: item.id || existing.id } : item);
  }
  return [...rows.values()];
}

export default function Home() {
  const [selected, setSelected] = useState(1);
  const [tab, setTab] = useState("总览");
  const [toast, setToast] = useState("");
  const [ready, setReady] = useState(false);
  const [baiduConnected, setBaiduConnected] = useState(false);
  const [liveScan, setLiveScan] = useState<any>(null);
  const [draftStartRequestId, setDraftStartRequestId] = useState(0);
  const [editProjectId, setEditProjectId] = useState("");
  const [publications, setPublications] = useState<any[]>([]);
  const [douyinRecords, setDouyinRecords] = useState<any[]>(douyinPerformanceBaseline);
  const handleBaiduValidated = useCallback((value: boolean) => setBaiduConnected(value), []);
  const handleScan = useCallback((value: any) => { setLiveScan(value); setSelected(1); }, []);
  const topics: Topic[] = liveScan?.topics || [];
  const active = useMemo(() => topics.find((t) => t.id === selected) ?? topics[0], [selected, topics]);
  const sevenDayPerformance = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = publications.filter((item) => item.snapshot?.collectedAt && new Date(item.snapshot.collectedAt).getTime() >= cutoff);
    const groups = new Map<string, { platform: string; posts: number; views: number; likes: number; comments: number; shares: number; favorites: number; restricted: number }>();
    for (const item of recent) {
      const snapshot = item.snapshot;
      const platform = snapshot.platform || "未识别平台";
      const row = groups.get(platform) || { platform, posts: 0, views: 0, likes: 0, comments: 0, shares: 0, favorites: 0, restricted: 0 };
      row.posts += 1;
      for (const key of ["views", "likes", "comments", "shares", "favorites"] as const) row[key] += Number(snapshot.metrics?.[key] || 0);
      if (snapshot.status === "page_restricted") row.restricted += 1;
      groups.set(platform, row);
    }
    const rows = [...groups.values()].map((row) => ({ ...row, engagement: row.views ? ((row.likes + row.comments + row.shares + row.favorites) / row.views) * 100 : null })).sort((a, b) => b.views - a.views);
    return { rows, posts: recent.length, views: rows.reduce((sum, row) => sum + row.views, 0) };
  }, [publications]);
  const douyinReview = useMemo(() => {
    const mature = douyinRecords.filter((item) => Number(item.views || 0) >= 40);
    const latest = [...douyinRecords].filter((item) => item.publishedAt).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, 3);
    const seen = new Set(latest.map((item) => item.id));
    const top = [...latest, ...[...mature].sort((a, b) => b.views - a.views).filter((item) => !seen.has(item.id)).slice(0, 5)];
    const detailCount = douyinRecords.filter((item) => item.detailCollected || item.twoSecondBounceRate != null || item.fiveSecondCompletionRate != null || item.trafficSources).length;
    const collectedTimes = douyinRecords.map((item) => Date.parse(item.collectedAt || "")).filter(Number.isFinite);
    return {
      count: douyinRecords.length,
      medianViews: median(mature.map((item) => item.views)),
      medianWatchSeconds: median(mature.map((item) => Number(item.averageWatchSeconds || 0)).filter((value) => value > 0)),
      top, detailCount,
      latestCollectedAt: collectedTimes.length ? new Date(Math.max(...collectedTimes)).toISOString() : "",
    };
  }, [douyinRecords]);

  useEffect(() => {
    const openTab = window.localStorage.getItem("financial-titan-open-tab");
    if (openTab) { setTab(openTab); window.localStorage.removeItem("financial-titan-open-tab"); }
    const stored = window.localStorage.getItem("fin-titan-selected");
    if (stored) setSelected(Number(stored));
    const loadPublications = () => setPublications(JSON.parse(window.localStorage.getItem("financial-titan-publication-links") || "[]"));
    const loadDouyinReviews = () => {
      try { setDouyinRecords(mergeDouyinReviews(JSON.parse(window.localStorage.getItem("financial-titan-douyin-live-reviews") || "[]"))); }
      catch { setDouyinRecords(douyinPerformanceBaseline); }
    };
    window.localStorage.setItem("financial-titan-douyin-performance-baseline", JSON.stringify(douyinPerformanceBaseline));
    loadPublications();
    loadDouyinReviews();
    window.addEventListener("financial-titan-publications-updated", loadPublications);
    window.addEventListener("financial-titan-douyin-reviews-updated", loadDouyinReviews);
    setReady(true);
    return () => {
      window.removeEventListener("financial-titan-publications-updated", loadPublications);
      window.removeEventListener("financial-titan-douyin-reviews-updated", loadDouyinReviews);
    };
  }, []);

  useEffect(() => {
    if (ready) window.localStorage.setItem("fin-titan-selected", String(selected));
  }, [selected, ready]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  function openHuasheng() {
    window.open("https://www.huasheng.cn/", "_blank", "noopener,noreferrer");
    notify("已打开花生AI，稿件交接清单已准备");
  }

  return (
    <>
      <div className="adaptiveMobileRoot">
        <MobileApp />
      </div>
      <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">金</div>
          <div><b>金融巨子</b><span>CONTENT OS</span></div>
        </div>
        <nav>
          {["总览", "稿件工坊", "资产库", "策略迭代"].map((item, i) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
              <span className="navIcon">{["◫", "✎", "▣", "↻"][i]}</span>{item}
            </button>
          ))}
        </nav>
        <div className="sidebarBottom">
          <div className="autoStatus"><i /><span><b>本地工作流就绪</b><small>实时数据源未接入</small></span></div>
        </div>
      </aside>

      <section className="content">
        <header>
          <div>
            <p className="eyebrow">FRIDAY · 2026.07.31</p>
            <h1>{tab === "总览" ? "今日编辑台" : tab}</h1>
            <p className="subtitle">从全球市场噪音里，找到今天最值得讲的一个判断。</p>
          </div>
          <div className="headerActions">
            <div className="avatar">巨</div>
          </div>
        </header>

        {tab === "稿件工坊" && <CreatorWorkflow key={editProjectId ? `edit-${editProjectId}` : `draft-${draftStartRequestId}`} notify={notify} selectedTopic={editProjectId ? undefined : active?.title} selectedTopicData={editProjectId ? undefined : active} startRequestId={editProjectId ? 0 : draftStartRequestId} editProjectId={editProjectId} />}
        {tab === "资产库" && <ProjectLibrary notify={notify} onEditProject={(projectId) => { setEditProjectId(projectId); setDraftStartRequestId(0); setTab("稿件工坊"); notify("已载入指定项目，继续编辑不会创建副本"); }} />}
        {tab === "策略迭代" && <StrategyIterationPanel notify={notify} />}
        <div style={{display: tab === "总览" ? "block" : "none"}}>
        <BaiduSourcePanel notify={notify} onValidated={handleBaiduValidated} onScan={handleScan} />
        <div className="stats">
          <div><span>今日真实候选</span><strong>{liveScan ? topics.length : "—"}</strong><small>{liveScan ? `${liveScan.mainTopicCount} 个达到主推门槛` : baiduConnected ? "等待执行今日扫描" : "热点源尚未接入"}</small></div>
          <div><span>待审稿件</span><strong>—</strong><small>等待本地资产同步</small></div>
          <div><span>近 7 日播放</span><strong>{sevenDayPerformance.posts ? sevenDayPerformance.views.toLocaleString("zh-CN") : "—"}</strong><small>{sevenDayPerformance.posts ? `${sevenDayPerformance.posts} 条投稿链接` : "尚无真实平台数据"}</small></div>
          <div><span>内容健康度</span><strong>—</strong><small>样本不足，暂不评分</small></div>
        </div>

        <section className="workflowCard">
          <div className="sectionTitle">
            <div><p className="eyebrow">DAILY ENGINE</p><h2>今日生产流水线</h2></div>
            <span className="live manual"><i /> 本地手动模式</span>
          </div>
          <div className="pipeline">
            {pipeline.map((step, i) => {
              const liveDone = i === 0 ? baiduConnected : step.done;
              return (
                <div className="pipe" key={step.label}>
                  <div className={liveDone ? "pipeCircle done" : "pipeCircle"}>{liveDone ? "✓" : i + 1}</div>
                  <b>{step.label}</b><span>{i === 0 && baiduConnected ? "搜索数据源已验证" : step.status}</span>
                  {i < pipeline.length - 1 && <div className={liveDone ? "line done" : "line"} />}
                </div>
              );
            })}
          </div>
        </section>

        <section className="engineCard">
          <div className="sectionTitle">
            <div><p className="eyebrow">TOPIC ENGINE V3</p><h2>先形成事件全集，再连接行情与根因</h2></div>
            <span className="engineVersion">{liveScan ? `实时扫描完成 · ${new Date(liveScan.scannedAt).toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"})}` : baiduConnected ? "搜索数据源已接入 · 等待扫描" : "评分规则已配置 · 数据源待接入"}</span>
          </div>
          <div className="engineFlow">
            <span><b>01</b>覆盖矩阵<small>市场·政策·公司·产业·跨资产</small></span>
            <i>→</i><span><b>02</b>动态理解<small>实体·动作·对象·阶段</small></span>
            <i>→</i><span><b>03</b>事件标准化<small>行情事实与原因事件分开</small></span>
            <i>→</i><span><b>04</b>因果连接<small>时间·对象·机制·反证</small></span>
            <i>→</i><span><b>05</b>双轨排序<small>搜索需求 × 推荐传播</small></span>
          </div>
          <div className="ruleGrid">
            {topicEngineRules.map((item) => (
              <div key={item.name}><strong>{item.name}</strong><p>{item.rule}</p><em>{item.weight}</em></div>
            ))}
          </div>
          <div className="engineFoot">
            <span><b>事件全集</b> 所有已标准化事件</span>
            <span><b>立即做</b> 排名前五 · 至少一个8小时内事件</span>
            <span><b>备选</b> 排名六至十</span>
            <span><b>诊断提醒</b> 不阻止事件被发现</span>
          </div>
        </section>

        <div className="grid">
          <section className="topicPanel">
            <div className="sectionTitle compact">
              <div><p className="eyebrow">TOPIC RADAR</p><h2>今日高潜选题</h2></div>
              <span className="demoLabel">{liveScan ? `百度实时扫描 · ${liveScan.queryCount} 组查询` : "等待真实扫描"}</span>
            </div>
            <div className="topicList">
              {!liveScan && <div className="emptyTopics"><b>选择并验证搜索数据源，再扫描今日热点</b><span>扫描前不展示静态选题，避免把演示数据当成实时判断。</span></div>}
              {liveScan && topics.length === 0 && <div className="emptyTopics"><b>本轮没有形成可理解的财经事件</b><span>请在召回诊断中检查时间过滤、未分类证据和语义引擎回执。</span></div>}
              {topics.map((topic, i) => (
                <button className={`topic ${selected === topic.id ? "selected" : ""}`} key={topic.id} onClick={() => setSelected(topic.id)}>
                  <div className={`rank ${topic.accent}`}>0{i + 1}</div>
                  <div className="topicBody">
                    <div className="topicTop"><span className={`badge ${topic.status}`}>{topic.status}</span><span className="score">综合 {topic.score}</span></div>
                    <h3>{topic.title}</h3>
                    <p>{topic.thesis}</p>
                    <div className="marketTags"><span className="fresh">● {topic.freshness}</span>{topic.category && <span>{topic.category}</span>}{topic.markets.map((m) => <span key={m}>{m}</span>)}<span>{topic.trigger}</span></div>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <aside className="decisionPanel">
            <p className="eyebrow">EDITOR&apos;S PICK</p>
            <div className="scoreRing"><strong>{active?.score ?? "—"}</strong><span>推荐指数</span></div>
            <h2>为什么今天讲这个？</h2>
            {active ? <ul>
              <li><b>来源有效</b><span>{active.sourceCount} 个独立站点，含 {active.authorityCount} 个高可信来源</span></li>
              <li><b>热度可解释</b><span>{active.socialCount || 0} 个社交信号，事件强度与来源扩散共同计分</span></li>
              <li><b>个股接近度</b><span>{active.investorProximity ?? 0} 分；只奖励真实关注、本股定价冲击与可感知业务，不按知名度硬加分</span></li>
              <li><b>跨市场价值</b><span>{active.markets.join(" → ")}，可形成可验证的传导判断</span></li>
            </ul> : <div className="emptyDecision">完成实时扫描后，这里会展示第一名选题的证据门槛和评分依据。</div>}
            <div className="miniScores">
              <div><span>传播热度</span><b>{active?.heat ?? "—"}</b><i style={{width: `${active?.heat || 0}%`}} /></div>
              <div><span>账号匹配</span><b>{active?.fit ?? "—"}</b><i style={{width: `${active?.fit || 0}%`}} /></div>
              <div><span>分析纵深</span><b>{active?.depth ?? "—"}</b><i style={{width: `${active?.depth || 0}%`}} /></div>
            </div>
            <button className="primary wide" disabled={!active || active.status === "观察"} onClick={() => { if (!active) return; setEditProjectId(""); setDraftStartRequestId(Date.now()); setTab("稿件工坊"); notify("已按当前热点创建全新稿件任务"); }}>用这个选题开稿　→</button>
          </aside>
        </div>

        <div className="bottomGrid">
          <section className="performance">
            <div className="sectionTitle compact">
              <div><p className="eyebrow">PERFORMANCE</p><h2>近 7 日平台表现</h2></div>
            </div>
            {sevenDayPerformance.rows.length ? <div className="performanceTable">
              <div className="tableHead"><span>平台</span><span>投稿</span><span>播放</span><span>互动</span><span>互动率</span></div>
              {sevenDayPerformance.rows.map((row) => {
                const interactions = row.likes + row.comments + row.shares + row.favorites;
                return <div className="tableRow" key={row.platform}>
                  <span className="platform"><i style={{background: row.platform === "YouTube" ? "#ef4444" : row.platform === "Bilibili" ? "#43b5e9" : "#171820"}} />{row.platform}</span>
                  <b>{row.posts}</b><b>{row.views ? row.views.toLocaleString("zh-CN") : "—"}</b><b>{interactions ? interactions.toLocaleString("zh-CN") : "—"}</b>
                  <span className="index">{row.engagement == null ? "页面未公开" : <><i><em style={{width: `${Math.min(100, row.engagement * 5)}%`}} /></i>{row.engagement.toFixed(1)}%</>}</span>
                </div>;
              })}
              <p className="metricDisclosure">统计最近7天采集到的公开页面数据；平台未公开的播放或互动不会估算。</p>
            </div> : <div className="emptyMetrics">
              <i>∅</i>
              <div><b>还没有真实发布数据</b><p>在资产库为稿件添加平台视频链接后，系统会读取公开页面指标并自动汇总到这里。</p></div>
            </div>}
          </section>

          <section className="nextAction">
            <p className="eyebrow">NEXT ACTION</p>
            <div className="peanut">花生<span>AI</span></div>
            <h2>稿件成片交接</h2>
            <p>将定稿文案带入花生AI，生成 9:16 与 16:9 两个母版，再按平台调整标题、字幕密度和前 3 秒画面。</p>
            <div className="checklist"><span>✓ 口播稿</span><span>✓ 素材提示</span><span>✓ 分镜节奏</span><span>✓ 平台标题</span></div>
            <button className="peanutBtn" onClick={openHuasheng}>打开花生AI制作 →</button>
          </section>
        </div>

        <section className="performanceReview">
          <div className="sectionTitle compact">
            <div><p className="eyebrow">DOUYIN REVIEW</p><h2>抖音历史复盘指标</h2></div>
            <span className="engineVersion">最新 3 条优先 · 已沉淀 {douyinReview.count} 条后台数据 · {douyinReview.detailCount} 条含详细指标</span>
          </div>
          <div className="reviewBenchmarks">
            <span><small>成熟作品中位播放</small><b>{douyinReview.medianViews.toLocaleString("zh-CN")}</b></span>
            <span><small>中位平均观看</small><b>{douyinReview.medianWatchSeconds.toFixed(1)} 秒</b></span>
            <span><small>留存目标</small><b>平均观看 ≥ 45秒</b></span>
            <span><small>开头目标</small><b>2秒跳出 &lt; 30%</b></span>
            <span><small>前段目标</small><b>5秒完播 ≥ 50%</b></span>
          </div>
          <div className="reviewTable">
            <div className="reviewRow reviewHead"><span>作品</span><span>播放</span><span>平均观看</span><span>2秒跳出</span><span>5秒完播</span><span>主流量</span><span>自动诊断</span></div>
            {douyinReview.top.map((item) => {
              const lead = Object.entries(item.trafficSources || {}).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
              return <div className="reviewRow" key={item.id}><span title={item.title}>{item.title}</span><b>{item.views.toLocaleString("zh-CN")}</b><b>{item.averageWatchSeconds.toFixed(1)}秒</b><b>{item.twoSecondBounceRate == null ? "—" : `${item.twoSecondBounceRate}%`}</b><b>{item.fiveSecondCompletionRate == null ? "—" : `${item.fiveSecondCompletionRate}%`}</b><b>{lead ? `${lead[0]} ${lead[1]}%` : "—"}</b><em>{diagnoseDouyinPerformance(item, douyinReview.medianViews, douyinReview.medianWatchSeconds)}</em></div>;
            })}
          </div>
          <p className="metricDisclosure">数据来自抖音创作者中心，最近同步：{douyinReview.latestCollectedAt ? new Date(douyinReview.latestCollectedAt).toLocaleString("zh-CN") : "尚无时间记录"}；详情页没有展示的留存与来源字段保持为空，不做估算。</p>
        </section>

        <section className="method">
          <div><p className="eyebrow">THE PLAYBOOK</p><h2>金融巨子 · 内容判断框架</h2></div>
          <div className="methodSteps">
            <span><b>01</b><em>热点真伪</em><small>讨论增速 × 权威信源</small></span>
            <span><b>02</b><em>市场映射</em><small>美股 → 港股 → A股</small></span>
            <span><b>03</b><em>历史校验</em><small>周期案例 × 大师观点</small></span>
            <span><b>04</b><em>表达重构</em><small>反常识 Hook × 口语叙事</small></span>
            <span><b>05</b><em>数据回流</em><small>完播 × 互动 × 转粉</small></span>
          </div>
        </section>
        <section className="fusionCard">
          <div><p className="eyebrow">PEANUTCUT FUSION</p><h2>新增闭环能力</h2></div>
          <div className="fusionGrid">
            <span><b>实时失败保护</b><small>核心数据源过期或抓取失败时停止主推，不用缓存伪装实时。</small><em>已完成</em></span>
            <span><b>内容资产库</b><small>稿件自动存档、历史检索、系列管理、发布指标回填。</small><em>已完成</em></span>
            <span><b>两个人工闸门</b><small>选题确认后才研究；标题、封面、Hook确认后才成稿。</small><em>已完成</em></span>
            <span><b>花生纯口播</b><small>研究标注与分镜不混入口播，中文标点和数字读法单独校验。</small><em className="building">下一步</em></span>
          </div>
        </section>
        </div>
      </section>
      {toast && <div className="toast">✓　{toast}</div>}
      </main>
    </>
  );
}
