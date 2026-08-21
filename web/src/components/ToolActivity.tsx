import { plannedMap, toolActivityItems } from "../lib/live";
import { translateRunEvent } from "../lib/event-translator";
import type { RunEvent } from "../lib/types";

export function ToolActivity({ events }: { readonly events: readonly RunEvent[] }): React.ReactNode {
  const list = toolActivityItems(events);
  if (list.length === 0) return null;
  const planned = plannedMap(events);
  const shown = list.slice(-10);
  const extra = list.length - shown.length;
  const rows = shown.map((e) => {
    const translated = translateRunEvent(e, planned);
    const tone = translated.tone;
    const icon = tone === "good" ? "✓" : tone === "bad" ? "✕" : "●";
    return (
      <li className={"tool-log-item " + tone} key={e.seq}>
        <span className="tool-log-icon">{icon}</span>
        <span className="tool-log-copy">
          <strong>{translated.title}</strong>
          {translated.detail ? <span>{translated.detail}</span> : null}
          <code>{translated.rawType}</code>
        </span>
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
