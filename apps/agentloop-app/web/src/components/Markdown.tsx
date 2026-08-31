import { renderMarkdown } from "../lib/md";

export function Markdown({ text }: { readonly text: unknown }): React.ReactNode {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}