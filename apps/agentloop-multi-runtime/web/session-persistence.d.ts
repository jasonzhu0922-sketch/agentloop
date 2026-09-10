export interface SessionPersistenceResult {
  readonly persisted: boolean;
  readonly tier?: Readonly<Record<string, number>>;
}

export function persistSessions(storage: Pick<Storage, "setItem" | "removeItem">, sessions: readonly unknown[]): SessionPersistenceResult;
export function persistJson(storage: Pick<Storage, "setItem">, key: string, value: unknown): boolean;
