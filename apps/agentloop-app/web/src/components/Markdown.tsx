import { renderMarkdown } from "@zhujun/agentloop-artifact-preview";

export function Markdown({ text }: { readonly text: unknown }): React.ReactNode {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
