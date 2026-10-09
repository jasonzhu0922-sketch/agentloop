/**
 * Keeps a streaming surface pinned only when its reader has not scrolled away
 * from the newest content.  The inputs deliberately match HTMLElement scroll
 * metrics so this rule can be tested without a browser.
 */
export function isNearBottom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 }, threshold = 32) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop) <= threshold;
}

export function nextScrollTop({ scrollHeight = 0, clientHeight = 0 }, shouldFollow, previousScrollTop = 0) {
  const maximum = Math.max(0, scrollHeight - clientHeight);
  return shouldFollow ? maximum : Math.min(Math.max(0, previousScrollTop), maximum);
}
