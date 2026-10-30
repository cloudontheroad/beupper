"use client";
import { learnLatestDouyinSnapshot } from "./strategy-learning";

import { useEffect, useState } from "react";
import { downloadCover, localizeCoverUrl } from "./image-download";
import { apiUrl, readJsonResponse } from "./api-client";
import { douyinPerformanceBaseline } from "./douyin-performance-baseline";
import { buildDouyinSyncFocus, compactDouyinSyncSnapshot } from "./douyin-sync-focus";

const stepNames = ["选题确认", "研究底稿", "包装确认", "口播成稿", "花生成片", "数据回流"];

function normalizeReviewTitle(value: string) {
  return value.toLowerCase().replace(/#[^\s]+/g, "").replace(/[\s\p{P}\p{S}]/gu, "").replace(/昨夜|今天|今日|刚刚|到底|接下来|怎么看|三个信号/g, "");
}

function titleBigrams(value: string) {
  const text = normalizeReviewTitle(value);
  return new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2)));
}

function reviewSimilarity(left: string, right: string) {
  const a = normalizeReviewTitle(left); const b = normalizeReviewTitle(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const aa = titleBigrams(a); const bb = titleBigrams(b);
  const overlap = [...aa].filter((item) => bb.has(item)).length;
  return (2 * overlap) / Math.max(1, aa.size + bb.size);
}

function bindReviewsByPublishingOrder(projects: any[], links: any[], manual: Record<string, string>, sourceReviews: any[] = douyinPerformanceBaseline) {
  const reviews = [...sourceReviews].sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  const projectRows = projects.map((project) => {
    const linkedTitles = links.filter((item) => item.contentId === project.id).map((item) => item.snapshot?.title).filter(Boolean);
    return { project, titles: [project.packaging?.title, project.topic, ...linkedTitles].filter(Boolean).map(String) };
  });
  const rows = projectRows.length; const columns = reviews.length;
  const dp = Array.from({ length: rows + 1 }, () => Array(columns + 1).fill(Number.NEGATIVE_INFINITY));
  const path = Array.from({ length: rows + 1 }, () => Array(columns + 1).fill(""));
  dp[0][0] = 0;
  for (let i = 0; i <= rows; i += 1) for (let j = 0; j <= columns; j += 1) {
    if (!Number.isFinite(dp[i][j])) continue;
    if (i < rows && dp[i][j] - 1.2 > dp[i + 1][j]) { dp[i + 1][j] = dp[i][j] - 1.2; path[i + 1][j] = "project-gap"; }
    if (j < columns && dp[i][j] - 1.2 > dp[i][j + 1]) { dp[i][j + 1] = dp[i][j] - 1.2; path[i][j + 1] = "review-gap"; }
    if (i < rows && j < columns) {
      const similarity = Math.max(0, ...projectRows[i].titles.map((title) => reviewSimilarity(title, reviews[j].title)));
      const manuallyLocked = manual[projectRows[i].project.id] === reviews[j].id;
      // 主题一致性是硬门，顺序只能在主题已经相符的候选之间消歧，绝不能把相邻但无关的项目强行配对。
      if (manuallyLocked || similarity >= 0.16) {
        const matchScore = dp[i][j] + 3 + similarity * 5 + (manuallyLocked ? 100 : 0);
        if (matchScore > dp[i + 1][j + 1]) { dp[i + 1][j + 1] = matchScore; path[i + 1][j + 1] = "match"; }
      }
    }
  }
  const next: Record<string, string> = {}; let i = rows; let j = columns;
  while (i > 0 || j > 0) {
    const action = path[i][j];
    if (action === "match") { next[projectRows[i - 1].project.id] = reviews[j - 1].id; i -= 1; j -= 1; }
    else if (action === "project-gap") i -= 1;
    else if (action === "review-gap") j -= 1;
    else break;
  }
  for (const [projectId, reviewId] of Object.entries(manual)) {
    for (const [otherProjectId, otherReviewId] of Object.entries(next)) if (otherProjectId !== projectId && otherReviewId === reviewId) delete next[otherProjectId];
    next[projectId] = reviewId;
  }
  return next;
}

export function ProjectLibrary({ notify, onEditProject }: { notify: (message: string) => void; onEditProject: (projectId: string) => void }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [links, setLinks] = useState<any[]>([]);
  const [newLink, setNewLink] = useState("");
  const [mobilePickerOpen, setMobilePickerOpen] = useState(false);
  const [reviewBindings, setReviewBindings] = useState<Record<string, string>>({});
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [reviewSearch, setReviewSearch] = useState("");
  const [douyinReviews, setDouyinReviews] = useState<any[]>(douyinPerformanceBaseline);
  const [douyinSyncing, setDouyinSyncing] = useState(false);
  const [douyinSyncMessage, setDouyinSyncMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      const raw = JSON.parse(window.localStorage.getItem("financial-titan-projects") || "[]");
      const archivedAssets = JSON.parse(window.localStorage.getItem("financial-titan-content-assets") || "[]");
      const archivedById = new Map(archivedAssets.map((item: any) => [item.id, item]));
      // 历史版本可能在初始化竞态中写入同 ID 副本；按 ID 只保留最近更新的一份。
      const byId = new Map<string, any>();
      for (const item of raw) {
        const existing = byId.get(item.id);
        if (!existing || String(item.updatedAt) > String(existing.updatedAt)) byId.set(item.id, item);
      }
      let coverIndex: Record<string, any> = {};
      try {
        const localHost = window.location.hostname === "localhost" ? "localhost" : "127.0.0.1";
        const indexUrl = ["localhost", "127.0.0.1"].includes(window.location.hostname)
          ? `${window.location.protocol}//${localHost}:4318/covers/index.json?t=${Date.now()}`
          : `/generated-covers/index.json?t=${Date.now()}`;
        const response = await fetch(indexUrl, { cache: "no-store" });
        if (response.ok) coverIndex = await response.json();
      } catch {}
      const saved = [...byId.values()].map((project: any) => {
        const backup = archivedById.get(project.id) as any;
        const indexed = coverIndex[project.id] || {};
        const coverImages = {
          landscape: project.coverImages?.landscape || backup?.coverImages?.landscape || indexed.landscape,
          portrait: project.coverImages?.portrait || backup?.coverImages?.portrait || indexed.portrait,
        };
        return { ...project, coverImages };
      }).sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      window.localStorage.setItem("financial-titan-projects", JSON.stringify(saved));
      if (cancelled) return;
      setProjects(saved);
      setSelectedId(saved[0]?.id || "");
      const storedLinks = JSON.parse(window.localStorage.getItem("financial-titan-publication-links") || "[]");
      const manualBindings = JSON.parse(window.localStorage.getItem("financial-titan-douyin-review-manual-bindings") || "{}");
      const liveReviews = JSON.parse(window.localStorage.getItem("financial-titan-douyin-live-reviews") || "[]");
      const reviewMap = new Map<string, any>();
      for (const item of [...douyinPerformanceBaseline, ...liveReviews]) {
        const key = `${normalizeReviewTitle(item.title || "")}|${String(item.publishedAt || "").slice(0, 10)}`;
        const existing = reviewMap.get(key);
        reviewMap.set(key, existing ? { ...existing, ...item, id: item.id || existing.id } : item);
      }
      const mergedReviews = [...reviewMap.values()];
      const completedBindings = bindReviewsByPublishingOrder(saved, storedLinks, manualBindings, mergedReviews);
      setLinks(storedLinks);
      setDouyinReviews(mergedReviews);
      setReviewBindings(completedBindings);
      window.localStorage.setItem("financial-titan-douyin-review-bindings", JSON.stringify(completedBindings));
    }
    void loadProjects();
    return () => { cancelled = true; };
  }, []);

  const selected = projects.find((item) => item.id === selectedId);
  const selectedLinks = links.filter((item) => item.contentId === selectedId);
  const autoMatchedDouyinReview = selected ? douyinReviews.find((item) => {
    const normalize = (value: string) => value.toLowerCase().replace(/[#：:，,？?！!\s]/g, "");
    const projectTitle = normalize(selected.packaging?.title || selected.topic || "");
    const performanceTitle = normalize(item.title);
    return projectTitle.length >= 8 && (performanceTitle.includes(projectTitle.slice(0, 18)) || projectTitle.includes(performanceTitle.slice(0, 18)));
  }) : undefined;
  const matchedDouyinReview = selected
    ? douyinReviews.find((item) => item.id === reviewBindings[selected.id]) || selected.douyinReview || autoMatchedDouyinReview
    : undefined;
  const filteredDouyinReviews = douyinReviews.filter((item) => !reviewSearch.trim() || item.title.toLowerCase().includes(reviewSearch.trim().toLowerCase()));

  async function syncDouyinCreator() {
    setDouyinSyncing(true);
    setDouyinSyncMessage("正在检测登录态并读取作品…");
    try {
      const requestSync = async () => {
        const response = await fetch(apiUrl("/api/douyin/sync"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        return { response, payload: await readJsonResponse(response, "抖音创作者同步") };
      };
      let { response, payload } = await requestSync();
      if (response.status === 401 || payload.loginRequired) {
        const loginResponse = await fetch(apiUrl("/api/douyin/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const loginPayload = await readJsonResponse(loginResponse, "抖音登录");
        if (!loginResponse.ok) throw new Error(loginPayload.error || "无法打开抖音登录窗口");
        setDouyinSyncMessage("登录窗口已打开，正在等待登录完成；登录成功后会自动同步，无需再次点击…");
        notify("请在弹出的抖音创作者中心完成登录，本页会自动继续");
        const deadline = Date.now() + 5 * 60 * 1000;
        let loggedIn = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 2500));
          const statusResponse = await fetch(apiUrl("/api/douyin/status"), { cache: "no-store" });
          const statusPayload = await readJsonResponse(statusResponse, "抖音登录态检测");
          if (!statusResponse.ok) throw new Error(statusPayload.error || "抖音登录态检测失败");
          if (statusPayload.loggedIn) {
            loggedIn = true;
            break;
          }
          setDouyinSyncMessage("仍在等待抖音登录完成；请在登录窗口中完成扫码或验证…");
        }
        if (!loggedIn) throw new Error("等待抖音登录超时，请确认登录窗口中的验证已经完成后重试");
        setDouyinSyncMessage("已获取抖音登录态，正在自动读取全部历史作品并匹配…");
        ({ response, payload } = await requestSync());
      }
      if (!response.ok) throw new Error(payload.error || "抖音创作者数据读取失败");
      const liveReviews = Array.isArray(payload.records) ? payload.records : [];
      const previousSnapshots = JSON.parse(window.localStorage.getItem("financial-titan-douyin-sync-snapshots") || "[]");
      const previousReviews = previousSnapshots[0]?.records || JSON.parse(window.localStorage.getItem("financial-titan-douyin-live-reviews") || "[]");
      const focus = buildDouyinSyncFocus(previousReviews, liveReviews);
      const reviewMap = new Map<string, any>();
      for (const item of [...douyinPerformanceBaseline, ...liveReviews]) {
        const key = `${normalizeReviewTitle(item.title || "")}|${String(item.publishedAt || "").slice(0, 10)}`;
        const existing = reviewMap.get(key);
        reviewMap.set(key, existing ? { ...existing, ...item, id: item.id || existing.id } : item);
      }
      const mergedReviews = [...reviewMap.values()].sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
      const manual = JSON.parse(window.localStorage.getItem("financial-titan-douyin-review-manual-bindings") || "{}");
      const completed = bindReviewsByPublishingOrder(projects, links, manual, mergedReviews);
      const nextProjects = projects.map((project) => {
        const review = mergedReviews.find((item) => item.id === completed[project.id]);
        return review ? { ...project, douyinReview: review, updatedAt: project.updatedAt } : project;
      });
      setDouyinReviews(mergedReviews);
      setReviewPickerOpen(true);
      setReviewBindings(completed);
      setProjects(nextProjects);
      window.localStorage.setItem("financial-titan-douyin-live-reviews", JSON.stringify(liveReviews));
      window.localStorage.setItem("financial-titan-douyin-last-focus", JSON.stringify({ collectedAt: new Date().toISOString(), rows: focus }));
      window.localStorage.setItem("financial-titan-douyin-sync-snapshots", JSON.stringify([
        { collectedAt: new Date().toISOString(), records: compactDouyinSyncSnapshot(liveReviews) },
        ...previousSnapshots,
      ].slice(0, 20)));
      window.dispatchEvent(new Event("financial-titan-douyin-reviews-updated"));
      window.localStorage.setItem("financial-titan-douyin-review-bindings", JSON.stringify(completed));
      window.localStorage.setItem("financial-titan-projects", JSON.stringify(nextProjects));
      const detailedCount = liveReviews.filter((item: any) => item.detailCollected).length;
      const newest = focus[0];
      const baseMessage = `已读取 ${liveReviews.length} 条作品，其中 ${detailedCount} 条取得逐稿留存明细；本轮重点 ${focus.length} 条${newest ? `，最新《${newest.title}》${newest.views} 播放（${newest.reason}）` : ""}；自动匹配 ${Object.keys(completed).length} 个资产项目。`;
      try {
        setDouyinSyncMessage(`${baseMessage} 正在用 DeepSeek 学习最新快照…`);
        const learned = await learnLatestDouyinSnapshot();
        setDouyinSyncMessage(`${baseMessage} 已完成策略学习，覆盖 ${learned.iteration.sampleCount} 条真实作品。${learned.promotionWarning || ""}`);
        notify("最新抖音数据与迭代策略已保存");
      } catch (error) {
        setDouyinSyncMessage(`${baseMessage} 数据已保存；策略学习未完成：${error instanceof Error ? error.message : String(error)}。可在策略迭代页重试，无需重新同步。`);
        notify("数据已保存，策略学习状态请查看策略迭代页");
      }
    } catch (error) {
      setDouyinSyncMessage(error instanceof Error ? error.message : "抖音同步失败");
    } finally {
      setDouyinSyncing(false);
    }
  }

  function bindDouyinReview(reviewId: string) {
    if (!selected) return;
    const review = douyinReviews.find((item) => item.id === reviewId);
    const next = { ...reviewBindings, [selected.id]: reviewId };
    setReviewBindings(next);
    window.localStorage.setItem("financial-titan-douyin-review-bindings", JSON.stringify(next));
    const manual = JSON.parse(window.localStorage.getItem("financial-titan-douyin-review-manual-bindings") || "{}");
    window.localStorage.setItem("financial-titan-douyin-review-manual-bindings", JSON.stringify({ ...manual, [selected.id]: reviewId }));
    if (review) {
      const nextProjects = projects.map((project) => project.id === selected.id ? { ...project, douyinReview: review } : project);
      setProjects(nextProjects);
      window.localStorage.setItem("financial-titan-projects", JSON.stringify(nextProjects));
    }
    setReviewPickerOpen(false);
    setReviewSearch("");
    notify("抖音后台复盘数据已绑定到当前资产");
  }

  function saveLinks(next: any[]) {
    setLinks(next);
    window.localStorage.setItem("financial-titan-publication-links", JSON.stringify(next));
    window.dispatchEvent(new Event("financial-titan-publications-updated"));
  }

  async function collectPublication(link: any) {
    const stored = JSON.parse(window.localStorage.getItem("financial-titan-publication-links") || "[]");
    saveLinks(stored.map((item: any) => item.id === link.id ? { ...item, status: "collecting", error: "" } : item));
    try {
      const response = await fetch(apiUrl("/api/platform-metrics"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: link.inputUrl }),
      });
      const snapshot = await response.json();
      if (!response.ok) throw new Error(snapshot.error || "页面读取失败");
      const current = JSON.parse(window.localStorage.getItem("financial-titan-publication-links") || "[]");
      const next = current.map((item: any) => item.id === link.id ? { ...item, status: "collected", snapshot, history: [...(item.history || []), snapshot] } : item);
      saveLinks(next);
      notify(`${snapshot.platform} 数据已更新`);
    } catch (error) {
      const current = JSON.parse(window.localStorage.getItem("financial-titan-publication-links") || "[]");
      saveLinks(current.map((item: any) => item.id === link.id ? { ...item, status: "error", error: error instanceof Error ? error.message : "页面读取失败" } : item));
    }
  }

  function addPublication() {
    if (!selected || !newLink.trim()) return;
    const publication = { id: `publication-${Date.now()}`, contentId: selected.id, inputUrl: newLink.trim(), history: [], status: "pending" };
    saveLinks([...links, publication]);
    setNewLink("");
    void collectPublication(publication);
  }

  function deletePublication(link: any) {
    const platform = link.snapshot?.platform || "未识别平台";
    if (!window.confirm(`确定删除这条 ${platform} 投稿链接吗？\n\n该链接以及已经采集的历史数据都会被移除，稿件项目不会受影响。`)) return;
    const current = JSON.parse(window.localStorage.getItem("financial-titan-publication-links") || "[]");
    saveLinks(current.filter((item: any) => item.id !== link.id));
    notify("投稿链接及其采集数据已删除");
  }

  function continueProject() {
    if (!selected) return;
    window.localStorage.setItem("financial-titan-current-project", selected.id);
    onEditProject(selected.id);
  }

  async function copyScript() {
    if (!selected?.script) return;
    await navigator.clipboard.writeText(selected.script);
    notify("口播稿已复制");
  }

  function exportProject() {
    if (!selected) return;
    const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `金融巨子-${selected.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function deleteProject() {
    if (!selected) return;
    const label = selected.packaging?.title || selected.topic || "未命名项目";
    if (!window.confirm(`确定删除“${label}”吗？\n\n稿件、封面和绑定的投稿数据都会从本地资产库移除，此操作无法撤销。`)) return;
    const nextProjects = projects.filter((item) => item.id !== selected.id);
    const nextLinks = links.filter((item) => item.contentId !== selected.id);
    const contentAssets = JSON.parse(window.localStorage.getItem("financial-titan-content-assets") || "[]")
      .filter((item: any) => item.id !== selected.id);
    window.localStorage.setItem("financial-titan-projects", JSON.stringify(nextProjects));
    window.localStorage.setItem("financial-titan-content-assets", JSON.stringify(contentAssets));
    saveLinks(nextLinks);
    if (window.localStorage.getItem("financial-titan-current-project") === selected.id) {
      window.localStorage.removeItem("financial-titan-current-project");
      window.localStorage.removeItem("financial-titan-workflow");
    }
    setProjects(nextProjects);
    setSelectedId(nextProjects[0]?.id || "");
    notify("废弃项目及其投稿数据已删除");
  }

  return (
    <div className="libraryLayout">
      <div className="librarySyncBar"><div><b>抖音创作者数据同步</b><span>{douyinSyncMessage || "获取项目专属浏览器登录态，读取全部作品，并按主题与发布顺序匹配资产。人工绑定始终优先。"}</span></div><button className="primary" disabled={douyinSyncing} onClick={syncDouyinCreator}>{douyinSyncing ? "正在读取并匹配…" : "获取抖音登录态并同步"}</button></div>
      <div className="mobileProjectPicker">
        <span className="mobilePickerLabel">当前项目 · {projects.length ? `${projects.length} 个内容资产` : "暂无内容资产"}</span>
        <button className={mobilePickerOpen ? "mobilePickerTrigger open" : "mobilePickerTrigger"} onClick={() => setMobilePickerOpen((value) => !value)} aria-expanded={mobilePickerOpen} aria-haspopup="listbox">
          <span><b>{selected?.packaging?.title || selected?.topic || "选择一个项目"}</b><small>{selected ? `${stepNames[selected.step] || "进行中"} · ${new Date(selected.updatedAt).toLocaleString("zh-CN")}` : "资产库为空"}</small></span>
          <i>⌄</i>
        </button>
        {mobilePickerOpen && <div className="mobilePickerMenu" role="listbox" aria-label="资产项目">
          {projects.map((project) => {
            const active = project.id === selectedId;
            return <button role="option" aria-selected={active} className={active ? "active" : ""} key={project.id} onClick={() => { setSelectedId(project.id); setMobilePickerOpen(false); }}>
              <span><b>{project.packaging?.title || project.topic || "未命名项目"}</b><small>{stepNames[project.step] || "进行中"} · {new Date(project.updatedAt).toLocaleDateString("zh-CN")}</small></span>
              <i>{active ? "✓" : ""}</i>
            </button>;
          })}
        </div>}
      </div>
      <aside className="projectList">
        <div><p className="eyebrow">PROJECT ARCHIVE</p><h2>内容资产库</h2><span>{projects.length} 个项目</span></div>
        {projects.length ? projects.map((project) => (
          <button className={selectedId === project.id ? "selected" : ""} key={project.id} onClick={() => setSelectedId(project.id)}>
            <b>{project.packaging?.title || project.topic || "未命名项目"}</b>
            <span>{stepNames[project.step] || "进行中"} · {new Date(project.updatedAt).toLocaleString("zh-CN")}</span>
          </button>
        )) : <div className="emptyReturn"><b>暂无项目</b><span>进入稿件工坊后，系统会从第一步开始自动保存。</span></div>}
      </aside>
      {selected && (
        <section className="projectDetail">
          <div className="projectDetailHead"><div><p className="eyebrow">AUTO-SAVED OUTPUT</p><h2>{selected.packaging?.title || selected.topic}</h2></div><div><button className="dangerButton" onClick={deleteProject}>删除项目</button><button className="ghost" onClick={exportProject}>导出 JSON</button><button className="primary" onClick={continueProject}>继续编辑</button></div></div>
          <div className="projectMeta"><span>当前阶段<b>{stepNames[selected.step]}</b></span><span>创建时间<b>{new Date(selected.createdAt).toLocaleString("zh-CN")}</b></span><span>最近保存<b>{new Date(selected.updatedAt).toLocaleString("zh-CN")}</b></span></div>
          <article className="outputBlock"><h3>选题</h3><p>{selected.topic}</p></article>
          <article className="outputBlock"><h3>研究底稿</h3><div className="savedResearch">{(selected.research || []).map((item: any) => <span key={item.key}><b>{item.key} · {item.title}</b><small>{item.body}</small></span>)}</div></article>
          <article className="outputBlock"><h3>标题、Hook 与封面方案</h3><dl className="savedPackage"><div><dt>标题</dt><dd>{selected.packaging?.title}</dd></div><div><dt>Hook</dt><dd>{selected.packaging?.hook}</dd></div><div><dt>封面主锤字</dt><dd>{selected.packaging?.cover}</dd></div><div><dt>视觉方向</dt><dd>{selected.packaging?.visual}</dd></div></dl></article>
          {(selected.coverImages?.landscape || selected.coverImages?.portrait) && <article className="outputBlock"><h3>生成封面</h3><div className="savedCovers">{selected.coverImages.landscape && <figure><img src={localizeCoverUrl(selected.coverImages.landscape)} alt="已保存横版封面" /><figcaption><button onClick={() => downloadCover(selected.coverImages.landscape, "png", "金融巨子-横版封面")}>下载 PNG</button><button onClick={() => downloadCover(selected.coverImages.landscape, "jpg", "金融巨子-横版封面")}>下载 JPG</button></figcaption></figure>}{selected.coverImages.portrait && <figure><img src={localizeCoverUrl(selected.coverImages.portrait)} alt="已保存竖版封面" /><figcaption><button onClick={() => downloadCover(selected.coverImages.portrait, "png", "金融巨子-竖版封面")}>下载 PNG</button><button onClick={() => downloadCover(selected.coverImages.portrait, "jpg", "金融巨子-竖版封面")}>下载 JPG</button></figcaption></figure>}</div></article>}
          {selected.huashengTask?.status === "ready" && selected.huashengTask?.downloadUrl && <article className="outputBlock savedVideo"><div className="blockHead"><h3>花生成片</h3><a href={selected.huashengTask.downloadUrl} download>下载 MP4</a></div><video controls preload="metadata" src={selected.huashengTask.downloadUrl} /><p>{selected.huashengTask.aspect || "默认画幅"} · {selected.huashengTask.mode || "auto"} 模式 · 本地 huasheng-cli 生成</p></article>}
          <article className="outputBlock douyinReviewBinding">
            <div className="blockHead"><h3>抖音复盘关联</h3><button className="ghost" onClick={() => setReviewPickerOpen((value) => !value)}>{matchedDouyinReview ? "更换关联" : "选择历史作品"}</button></div>
            {matchedDouyinReview ? <>
              <p className="reviewBoundTitle"><b>{matchedDouyinReview.title}</b><span>{new Date(matchedDouyinReview.publishedAt).toLocaleString("zh-CN")} · 创作者中心快照</span></p>
              <div className="assetReviewSnapshot"><span>播放<strong>{matchedDouyinReview.views.toLocaleString("zh-CN")}</strong></span><span>平均观看<strong>{matchedDouyinReview.averageWatchSeconds.toFixed(1)}秒</strong></span><span>平均播放占比<strong>{matchedDouyinReview.averagePlayRatio}%</strong></span><span>2秒跳出<strong>{matchedDouyinReview.twoSecondBounceRate == null ? "—" : `${matchedDouyinReview.twoSecondBounceRate}%`}</strong></span><span>5秒完播<strong>{matchedDouyinReview.fiveSecondCompletionRate == null ? "—" : `${matchedDouyinReview.fiveSecondCompletionRate}%`}</strong></span><span>搜索/推荐<strong>{matchedDouyinReview.trafficSources ? `${matchedDouyinReview.trafficSources.搜索 || 0}% / ${matchedDouyinReview.trafficSources.推荐页 || 0}%` : "—"}</strong></span></div>
            </> : <div className="pendingCollect"><b>当前项目尚未关联抖音后台作品</b><span>可以从已抓取的 {douyinReviews.length} 条历史作品中选择；绑定只影响复盘索引，不会创建新项目。</span></div>}
            {reviewPickerOpen && <div className="reviewPicker"><input value={reviewSearch} onChange={(event) => setReviewSearch(event.target.value)} placeholder="搜索抖音作品标题" autoFocus /><div>{filteredDouyinReviews.map((item) => <button key={item.id} onClick={() => bindDouyinReview(item.id)}><span><b>{item.title}</b><small>{new Date(item.publishedAt).toLocaleDateString("zh-CN")} · {item.views.toLocaleString("zh-CN")} 播放 · 平均观看 {item.averageWatchSeconds.toFixed(1)} 秒</small></span><i>关联</i></button>)}</div></div>}
          </article>
          <article className="outputBlock publicationAssets">
            <div className="blockHead"><h3>投稿链接与平台数据</h3><span>{selectedLinks.length} 个平台</span></div>
            <div className="linkCollector"><label>追加平台视频链接<input value={newLink} onChange={(event) => setNewLink(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addPublication(); }} placeholder="粘贴抖音、小红书、Bilibili、YouTube 或 TikTok 链接" /></label><button className="primary" disabled={!newLink.trim()} onClick={addPublication}>添加并采集</button></div>
            {selectedLinks.map((link) => <div className="assetPublication" key={link.id}>
              <div><b>{link.snapshot?.platform || "等待识别"}</b><a href={link.inputUrl} target="_blank" rel="noreferrer">{link.inputUrl}</a></div>
              <div className="assetMetrics">{[["播放","views"],["点赞","likes"],["评论","comments"],["转发","shares"],["收藏","favorites"]].map(([label,key]) => { const value = link.snapshot?.metrics?.[key]; return <span key={key}><small>{label}</small><b>{value == null ? "—" : Number(value).toLocaleString("zh-CN")}</b></span>; })}</div>
              <div className="publicationActions"><span>{link.snapshot ? `最近采集 ${new Date(link.snapshot.collectedAt).toLocaleString("zh-CN")} · ${link.history?.length || 0} 次快照` : link.error || "等待首次采集"}</span><div><button className="ghost" disabled={link.status === "collecting"} onClick={() => collectPublication(link)}>{link.status === "collecting" ? "读取中…" : "刷新数据"}</button><button className="linkDeleteButton" onClick={() => deletePublication(link)}>删除链接</button></div></div>
            </div>)}
            {!selectedLinks.length && <div className="pendingCollect">尚未绑定投稿链接，可以在任何时间陆续补充多个平台。</div>}
          </article>
          <article className="outputBlock"><div className="blockHead"><h3>口播稿</h3><button className="ghost" onClick={copyScript}>复制全文</button></div><pre>{selected.script}</pre></article>
        </section>
      )}
    </div>
  );
}
