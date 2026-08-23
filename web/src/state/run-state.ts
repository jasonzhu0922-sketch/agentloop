import type { ConversationDetail, RunRecord } from "../lib/types";

export interface ConversationRunProjection {
  readonly run: RunRecord;
  readonly isLoaded: boolean;
  readonly isLive: boolean;
}

export function projectConversationRun(
  run: RunRecord,
  loadedRun: RunRecord | null | undefined,
  activeRunIds: readonly string[],
): ConversationRunProjection {
  const isLoaded = loadedRun?.id === run.id;
  const displayRun = isLoaded ? loadedRun : run;
  const isActive = activeRunIds.includes(run.id);
  return {
    run: displayRun,
    isLoaded,
    isLive: displayRun.status === "running" && (isLoaded || isActive),
  };
}

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
