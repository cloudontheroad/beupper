"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BaiduSourcePanel } from "../baidu-source-panel";
import { CreatorWorkflow } from "../creator-workflow";
import { ProjectLibrary } from "../project-library";
import { loadScanCache } from "../scan-cache";

type MobileTab = "热点" | "创作" | "资产";

function sourceUrl(topic: any) {
  const candidate = topic?.evidence?.find((item: any) => item?.url)?.url;
  try { return candidate ? new URL(candidate).toString() : ""; } catch { return ""; }
}

export default function MobileApp() {
  const [tab, setTab] = useState<MobileTab>("热点");
  const [scan, setScan] = useState<any>(null);
  const [selectedId, setSelectedId] = useState<number | string>(1);
  const [startRequestId, setStartRequestId] = useState(0);
  const [editProjectId, setEditProjectId] = useState("");
  const [toast, setToast] = useState("");
  const [sourceOpen, setSourceOpen] = useState(true);
  const [publications, setPublications] = useState<any[]>([]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const handleSourceValidated = useCallback(() => {}, []);
  const handleSourceScan = useCallback((value: any) => {
    setScan(value);
    setSelectedId(value?.topics?.[0]?.id || 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadScanCache().then((savedScan) => { if (!cancelled && savedScan) setScan(savedScan); }).catch(() => {});
    const loadPublications = () => setPublications(JSON.parse(window.localStorage.getItem("financial-titan-publication-links") || "[]"));
    loadPublications();
    window.addEventListener("financial-titan-publications-updated", loadPublications);
    return () => { cancelled = true; window.removeEventListener("financial-titan-publications-updated", loadPublications); };
  }, []);

  const topics = scan?.topics || [];
  const active = topics.find((item: any) => String(item.id) === String(selectedId)) || topics[0];
  const performance = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = publications.filter((item) => item.snapshot?.collectedAt && new Date(item.snapshot.collectedAt).getTime() >= cutoff);
    return {
      posts: recent.length,
      views: recent.reduce((sum, item) => sum + Number(item.snapshot?.metrics?.views || 0), 0),
      engagement: recent.reduce((sum, item) => sum + Number(item.snapshot?.metrics?.likes || 0) + Number(item.snapshot?.metrics?.comments || 0) + Number(item.snapshot?.metrics?.shares || 0), 0),
    };
  }, [publications]);

  function startTopic() {
    if (!active) return;
    setEditProjectId("");
    setStartRequestId(Date.now());
    setTab("创作");
    notify("已创建新稿件，进入移动端创作流程");
  }

  return (
    <main className="mobileApp">
      <header className="mobileTopbar">
        <div className="mobileBrand"><i>金</i><span><b>金融巨子</b><small>CONTENT OS · MOBILE</small></span></div>
        <span className="mobileLive"><i />本地链路</span>
      </header>

      <div className="mobileViewport">
        {tab === "热点" && (
          <div className="mobileDashboard">
            <section className="mobileHero">
              <p>DAILY MARKET BRIEF</p>
              <h1>今天，市场真正<br />在交易什么？</h1>
              <span>扫描全球市场异动，找到值得讲透的因果。</span>
            </section>

            <section className="mobileMetricStrip">
              <div><small>候选</small><b>{scan ? topics.length : "—"}</b></div>
              <div><small>近7日投稿</small><b>{performance.posts || "—"}</b></div>
              <div><small>播放</small><b>{performance.posts ? performance.views.toLocaleString("zh-CN") : "—"}</b></div>
              <div><small>互动</small><b>{performance.posts ? performance.engagement.toLocaleString("zh-CN") : "—"}</b></div>
            </section>

            <section className={`mobileSource ${sourceOpen ? "open" : ""}`}>
              <button className="mobileSectionToggle" onClick={() => setSourceOpen((value) => !value)}>
                <span><small>LIVE SOURCE</small><b>实时热点数据源</b></span><i>{sourceOpen ? "−" : "+"}</i>
              </button>
              {sourceOpen && <BaiduSourcePanel notify={notify} onValidated={handleSourceValidated} onScan={handleSourceScan} />}
            </section>

            <section className="mobileTopics">
              <div className="mobileSectionHead"><div><small>TOPIC RADAR</small><h2>今日高潜选题</h2></div><span>{topics.length ? `${topics.length} 条` : "待扫描"}</span></div>
              {!topics.length && <div className="mobileEmpty"><i>⌁</i><b>等待实时扫描</b><span>连接百度 WebSearch 后生成今日事件全集与头部选题。</span></div>}
              {topics.map((topic: any, index: number) => {
                const selected = String(topic.id) === String(active?.id);
                const url = sourceUrl(topic);
                return <article className={selected ? "mobileTopic selected" : "mobileTopic"} key={topic.id || index} onClick={() => setSelectedId(topic.id)}>
                  <div className="mobileTopicRank"><b>{String(index + 1).padStart(2, "0")}</b><span>{topic.status || "候选"}</span></div>
                  <div className="mobileTopicBody">
                    <div className="mobileTopicMeta"><span>{topic.category || "财经热点"}</span><em>{Math.round(Number(topic.score || 0))}分</em></div>
                    <h3>{topic.title}</h3>
                    <p>{topic.thesis || topic.trigger}</p>
                    <div className="mobileTags">{(topic.markets || []).slice(0, 4).map((market: string) => <span key={market}>{market}</span>)}<span>{topic.freshness || "实时"}</span></div>
                    {url && <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>查看首要信源 ↗</a>}
                  </div>
                  <button aria-label={`选择${topic.title}`}>{selected ? "✓" : ""}</button>
                </article>;
              })}
            </section>

            {active && <section className="mobilePick">
              <small>EDITOR&apos;S PICK</small><h2>{active.title}</h2>
              <p>{active.thesis || "围绕当前事件建立跨市场解释与可验证判断。"}</p>
              <div><span>热度<b>{active.heat ?? "—"}</b></span><span>匹配<b>{active.fit ?? "—"}</b></span><span>纵深<b>{active.depth ?? "—"}</b></span></div>
              <button onClick={startTopic}>用这个选题开稿 <i>→</i></button>
            </section>}
          </div>
        )}

        {tab === "创作" && <div className="mobileWorkarea">
          <CreatorWorkflow key={editProjectId ? `mobile-edit-${editProjectId}` : `mobile-draft-${startRequestId}`} notify={notify} selectedTopic={editProjectId ? undefined : active?.title} selectedTopicData={editProjectId ? undefined : active} startRequestId={editProjectId ? 0 : startRequestId} editProjectId={editProjectId} />
        </div>}

        {tab === "资产" && <div className="mobileLibrary">
          <ProjectLibrary notify={notify} onEditProject={(projectId) => { setEditProjectId(projectId); setStartRequestId(0); setTab("创作"); notify("已载入指定项目"); }} />
        </div>}
      </div>

      <nav className="mobileNav" aria-label="移动端主导航">
        {(["热点", "创作", "资产"] as MobileTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}><i>{item === "热点" ? "◫" : item === "创作" ? "✎" : "▣"}</i><span>{item}</span></button>)}
      </nav>
      {toast && <div className="mobileToast">{toast}</div>}
    </main>
  );
}
