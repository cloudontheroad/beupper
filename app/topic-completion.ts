// Shared by both coverage checks: adding an event to two protection lanes must
// not produce two supplemental model requests or two fallback topics.
export function uncoveredTopicEvents(events: any[], topics: any[], companyEvents: any[], entities: (event: any) => string[]) {
  const companyIds = new Set(companyEvents.map((e) => e.id || e.eventId));
  return [...new Map([...events, ...companyEvents].map((e) => [e.id || e.eventId, e])).values()].filter((event) => {
    const names = entities(event);
    return !topics.some((topic) => {
      const linked = [...(topic.observedEventIds || []), ...(topic.causalEventIds || [])].some((id) => id === event.id || id === event.eventId);
      return linked && (!companyIds.has(event.id || event.eventId) || names.some((name) => topic.title.includes(name)));
    });
  });
}

export function isGenericTopicTitle(title: string) {
  return /(?:本股|本轮)?估值要重算[吗么]|行情还能延续[吗么]|市场在重估什么/.test(title);
}
