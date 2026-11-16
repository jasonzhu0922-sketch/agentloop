export function renderHumanLoop(request: Record<string, any>): string;
export function readHumanLoopResponse(request: Record<string, any>, form: HTMLFormElement): unknown;
export function bindHumanLoop(form: HTMLFormElement, request: Record<string, any>, onRespond: (request: Record<string, any>, value: unknown) => Promise<void>): void;
