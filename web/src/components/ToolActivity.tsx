import { eventTone } from "../lib/format";
import { plannedMap, toolActivityItems, toolRowLabel } from "../lib/live";
import type { RunEvent } from "../lib/types";

export function ToolActivity({ events }: { readonly events: readonly RunEvent[] }): React.ReactNode {
  const list = toolActivityItems(events);
  if (list.length === 0) return null;
  const planned = plannedMap(events);
  const shown = list.slice(-10);
  const extra = list.length - shown.length;
  const rows = shown.map((e) => {
    const tone = eventTone(e.type);
    const icon = tone === "good" ? "✓" : tone === "bad" ? "✕" : "●";
    return (
      <li className={"tool-log-item " + tone} key={e.seq}>
        <span className="tool-log-icon">{icon}</span>
        <span>{toolRowLabel(e, planned)}</span>
      </li>
    );
  });
  return (
    <details className="tool-details" open>
      <summary>事件时间线 · {list.length} 条</summary>
      <ul className="tool-log">
        {extra > 0 ? <li className="tool-log-item muted">… 更早 {extra} 步</li> : null}
        {rows}
      </ul>
    </details>
  );
}
