/**
 * A reply card can be clicked to reveal its execution detail, but a drag over
 * its text must remain a normal browser text selection.  Keep that decision
 * independent from the rendering code so it is testable without a browser.
 */
export function hasSelectedTextWithin(selection, element) {
  if (!selection || selection.isCollapsed || selection.rangeCount < 1 || !selection.toString().trim()) return false;
  const range = selection.getRangeAt(0);
  if (typeof range.intersectsNode === "function") return range.intersectsNode(element);
  return element.contains(range.commonAncestorContainer);
}
