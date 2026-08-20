import type { ConversationDetail, RunRecord } from "../lib/types";

export function mergeRunIntoConversation(
  previous: ConversationDetail | null,
  run: RunRecord,
): ConversationDetail | null {
  if (previous === null || run.conversationId !== previous.conversation.id) return previous;

  let matched = false;
  const runs = previous.runs.map((candidate) => {
    if (candidate.id !== run.id) return candidate;
    matched = true;
    return run;
  });

  return {
    conversation: {
      ...previous.conversation,
      runCount: matched ? previous.conversation.runCount : previous.conversation.runCount + 1,
      lastStatus: run.status,
      updatedAt: Math.max(previous.conversation.updatedAt, run.finishedAt ?? run.createdAt),
    },
    runs: matched ? runs : [...runs, run],
  };
}
