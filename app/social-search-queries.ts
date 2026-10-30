// Search entities rather than the video's rhetorical question.
export function socialSearchQueries(topic: string, context: any = {}): string[] {
  const clean = (value: string) => value.replace(/雪球|X\/Twitter|Twitter|投资者讨论|分歧|热议/gi, " ").replace(/\s+/g, " ").trim();
  const entities = [...(Array.isArray(context.actors) ? context.actors : []), ...(Array.isArray(context.assets) ? context.assets : [])]
    .filter((value) => typeof value === "string").map(clean).filter((value) => value.length >= 2 && value.length <= 20);
  const lead = clean(topic.split(/[：:，,？?！!]/)[0] || topic);
  const fallback = lead.replace(/(?:宣布|发布|推出|股价|财报|业绩|净利润|营收|上市|配售|分红|回购|大涨|大跌|暴涨|暴跌|上涨|下跌|涨|跌|突破|冲上|重返).*/, "").replace(/[\d.%％]+$/, "").trim();
  return [...new Set(entities.length ? entities : [fallback.length >= 2 ? fallback : lead.slice(0, 24)])].slice(0, 2);
}
