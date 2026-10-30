"use client";

import { useEffect, useState } from "react";
import { apiUrl, readJsonResponse } from "./api-client";
import { learnLatestDouyinSnapshot } from "./strategy-learning";

export function StrategyIterationPanel({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [processing, setProcessing] = useState("");
  const [learningStatus, setLearningStatus] = useState<any>(null);

  useEffect(() => {
    const load = () => {
      try {
        setItems(JSON.parse(window.localStorage.getItem("financial-titan-strategy-iterations") || "[]"));
        setCandidates(JSON.parse(window.localStorage.getItem("financial-titan-promotion-candidates") || "[]"));
        setLearningStatus(JSON.parse(window.localStorage.getItem("financial-titan-learning-status") || "null"));
      }
      catch { setItems([]); }
    };
    load();
    window.addEventListener("financial-titan-strategy-updated", load);
    try {
    const snapshotAt = JSON.parse(window.localStorage.getItem("financial-titan-douyin-sync-snapshots") || "[]")[0]?.collectedAt;
    const previousAttempt = JSON.parse(window.localStorage.getItem("financial-titan-learning-status") || "null");
    const latestIteration = JSON.parse(window.localStorage.getItem("financial-titan-strategy-iterations") || "[]")[0];
    if (snapshotAt && (!latestIteration || Date.parse(latestIteration.createdAt) < Date.parse(snapshotAt))
      && previousAttempt?.snapshotAt !== snapshotAt && window.localStorage.getItem("financial-titan-deepseek-key")) {
      setProcessing("learning");
      learnLatestDouyinSnapshot().then(() => notify("最近同步的快照已补做策略学习")).catch(() => {}).finally(() => setProcessing(""));
    }
    } catch { /* Corrupt local snapshots must not break the strategy page. */ }
    return () => window.removeEventListener("financial-titan-strategy-updated", load);
  }, []);

  function saveCandidates(next: any[]) {
    setCandidates(next);
    window.localStorage.setItem("financial-titan-promotion-candidates", JSON.stringify(next));
  }

  async function approve(candidate: any) {
    if (!window.confirm(`确认把这条规则写入 ${candidate.targetSkill}？\n\n${candidate.rule}\n\n系统会先创建版本备份。`)) return;
    setProcessing(candidate.id);
    try {
      const response = await fetch(apiUrl("/api/strategy-promote"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidate }) });
      const payload = await readJsonResponse(response, "Skill晋升");
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Skill晋升失败");
      saveCandidates(candidates.map((item) => item.id === candidate.id ? { ...item, status: "approved", approvedAt: payload.approvedAt, backup: payload.backup } : item));
      notify("规则已写入稳定 Skill，后续生成立即生效");
    } catch (error) { notify(error instanceof Error ? error.message : "Skill晋升失败"); }
    finally { setProcessing(""); }
  }

  function reject(candidate: any) {
    const reason = window.prompt("拒绝原因（可选，供后续策略复盘参考）：", "证据不足或不适合作为通用规则") ?? "";
    saveCandidates(candidates.map((item) => item.id === candidate.id ? { ...item, status: "rejected", rejectedAt: new Date().toISOString(), rejectionReason: reason } : item));
    notify("已拒绝该晋升候选，动态策略不受影响");
  }

  return <section className="strategyPage">
    <div className="strategyHero">
      <p className="eyebrow">DOUYIN FEEDBACK LOOP</p>
      <h2>策略迭代列表</h2>
      <p>同步后优先复盘新稿与变化稿，并用全量真实作品对照；未匹配项目只分析标题和后台数据，不虚构正文。学习成功后策略才会生效。</p>
      <button className="primary" disabled={processing === "learning"} onClick={async () => {
        setProcessing("learning");
        try { await learnLatestDouyinSnapshot(); notify("已学习最近同步的数据，策略已更新"); }
        catch (error) { notify(error instanceof Error ? error.message : "学习失败"); }
        finally { setProcessing(""); }
      }}>{processing === "learning" ? "正在学习…" : "学习最近同步的数据 / 重试"}</button>
      {learningStatus && <p>最近学习：{learningStatus.state === "succeeded" ? "已完成" : learningStatus.state === "running" ? "请求已发起，等待结果；若页面已关闭可重试" : "未完成"} · {learningStatus.recordCount || 0} 条作品 · {new Date(learningStatus.updatedAt).toLocaleString("zh-CN")} {learningStatus.error || learningStatus.warning || ""}</p>}
    </div>
    <section className="promotionDesk">
      <div><p className="eyebrow">HUMAN APPROVAL</p><h2>待晋升规则</h2><span>只有通过3轮、14天、8篇作品、2类题材、去极值和指标门槛的规则才会进入这里；最终必须由你确认。</span></div>
      {!candidates.filter((item) => item.status === "pending").length && <div className="strategyEmpty"><b>暂无待确认规则</b><span>系统会继续从后续多轮同步中聚类验证，不会用单条爆款改写 Skill。</span></div>}
      <div className="promotionList">{candidates.map((candidate) => <article className={`promotionCandidate ${candidate.status}`} key={candidate.id}>
        <header><div><span>{candidate.targetSkill}</span><h3>{candidate.rule}</h3></div><em>{candidate.status === "approved" ? "已晋升" : candidate.status === "rejected" ? "已拒绝" : "待确认"}</em></header>
        <p>{candidate.rationale}</p>
        <div className="promotionGates"><span>{candidate.evidenceIterationIds?.length || 0}轮</span><span>{candidate.spanDays || 0}天</span><span>{candidate.uniquePostCount || candidate.supportingPostIds?.length || 0}篇</span><span>{candidate.supportingCategories?.length || 0}类题材</span><span>置信度 {candidate.confidence || "—"}</span></div>
        {candidate.metricEvidence?.length > 0 && <div className="promotionEvidence">{candidate.metricEvidence.map((metric: any, i: number) => <span key={i}>{metric.metric}：{metric.baseline} → {metric.test}（{metric.change > 0 ? "+" : ""}{metric.change}）</span>)}</div>}
        <small>去极值复核：{candidate.outlierCheck || "—"}；适用边界：{candidate.risks || "—"}</small>
        {candidate.status === "pending" && <footer><button disabled={processing === candidate.id} onClick={() => reject(candidate)}>拒绝</button><button className="primary" disabled={processing === candidate.id} onClick={() => approve(candidate)}>{processing === candidate.id ? "正在写入…" : "确认晋升到 Skill"}</button></footer>}
        {candidate.status === "approved" && <small>版本备份：{candidate.backup || "已保存"}</small>}
        {candidate.status === "rejected" && <small>拒绝原因：{candidate.rejectionReason || "未填写"}</small>}
      </article>)}</div>
    </section>
    {!items.length && <div className="strategyEmpty"><b>尚无策略迭代</b><span>前往资产库同步抖音创作者数据。已配置 DeepSeek Key 时自动学习；已有快照可直接重试，无需重新抓取。</span></div>}
    <div className="strategyList">
      {items.map((item, index) => <article className="strategyEntry" key={item.id || index}>
        <header><div><span>第 {items.length - index} 次迭代</span><h3>{item.summary || "内容策略复盘"}</h3></div><time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time></header>
        <div className="strategyMeta"><span>{item.sampleCount || 0} 条作品 · {item.matchedProjectCount ?? item.sampleCount ?? 0} 个匹配项目</span><span>{item.model || "DeepSeek"}</span><span>{item.receipt ? "API 已回执" : "无回执"}</span></div>
        {item.retailAttentionReview?.length > 0 && <details open><summary>散户关注度与选题需求复盘</summary>{item.retailAttentionReview.map((review: any, i: number) => <div className="strategyInsight" key={i}><b>{review.finding}</b><span>样本对照：{review.comparison}</span><span>缺失证据：{review.missing}</span><span>下一轮实验：{review.nextExperiment}</span></div>)}</details>}
        {item.dataBoundary && <p className="strategyBoundary">数据边界：{item.dataBoundary}</p>}
        {!!item.focus?.length && <div className="strategyFocus"><b>本轮优先复盘 · {item.focus.length} 条新稿/变化稿</b>{item.focus.map((row: any, i: number) => {
          const review = (item.focusReviews || [])[i] || {};
          return <div key={row.id || i}><strong>{row.title}</strong><span>{row.reason} · 本次 {row.views} 播放{row.previousViews == null ? "" : `，较上次 ${row.viewDelta >= 0 ? "+" : ""}${row.viewDelta}`} · {row.platformStatus === "abnormal" ? "后台状态异常" : "未见明确处罚状态"}</span>{review.verdict && <p>{review.verdict}</p>}{review.probableCause && <p>内容假设：{review.probableCause}</p>}{review.unknowns && <small>尚不能确认：{review.unknowns}</small>}{review.nextCheck && <small>下次核对：{review.nextCheck}</small>}</div>;
        })}</div>}
        <div className="strategyColumns">
          <section><b>选题迭代</b>{(item.topicDirectives || []).map((text: string, i: number) => <p key={i}>{text}</p>)}</section>
          <section><b>底稿迭代</b>{(item.researchDirectives || []).map((text: string, i: number) => <p key={i}>{text}</p>)}</section>
          <section><b>成稿迭代</b>{(item.scriptDirectives || []).map((text: string, i: number) => <p key={i}>{text}</p>)}</section>
        </div>
        {(item.insights || []).length > 0 && <details><summary>查看数据发现与证据</summary>{item.insights.map((insight: any, i: number) => <div className="strategyInsight" key={i}><b>{insight.finding}</b><span>{insight.evidence}</span><em>{insight.confidence || "—"}</em></div>)}</details>}
        {(item.experiments || []).length > 0 && <details><summary>查看下一轮单变量实验</summary>{item.experiments.map((experiment: any, i: number) => <div className="strategyExperiment" key={i}><b>{experiment.name}</b><span>{experiment.change}；成功指标：{experiment.successMetric}；样本：{experiment.sampleSize}</span></div>)}</details>}
      </article>)}
    </div>
  </section>;
}
