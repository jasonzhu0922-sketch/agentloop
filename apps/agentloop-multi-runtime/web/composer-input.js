export const MAX_COMPOSER_LINES = 3;

export function composerInputHeight(scrollHeight, lineHeight) {
  const contentHeight = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : 0;
  const resolvedLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 0;
  return resolvedLineHeight === 0 ? contentHeight : Math.min(contentHeight, resolvedLineHeight * MAX_COMPOSER_LINES);
}

export function autoResizeComposerInput(input, readLineHeight = (element) => Number.parseFloat(getComputedStyle(element).lineHeight)) {
  input.style.height = "auto";
  const height = composerInputHeight(input.scrollHeight, readLineHeight(input));
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > height ? "auto" : "hidden";
}

export function resetComposerInput(input) {
  input.style.height = "";
  input.style.overflowY = "";
}
