export const MAX_COMPOSER_LINES: 3;

export interface ComposerInputElement {
  readonly scrollHeight: number;
  readonly style: { height: string; overflowY: string };
}

export interface ComposerKeydownEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

export function shouldSubmitComposerOnKeydown(event: ComposerKeydownEvent): boolean;

export function composerInputHeight(scrollHeight: number, lineHeight: number): number;

export function autoResizeComposerInput(
  input: ComposerInputElement,
  readLineHeight?: (input: ComposerInputElement) => number,
): void;

export function resetComposerInput(input: Pick<ComposerInputElement, "style">): void;
