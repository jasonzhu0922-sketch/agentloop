export interface TextSelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  toString(): string;
  getRangeAt?(index: number): {
    intersectsNode?(node: unknown): boolean;
    readonly commonAncestorContainer?: unknown;
  };
}

export function hasSelectedTextWithin(selection: TextSelectionLike | null | undefined, element: unknown): boolean;
