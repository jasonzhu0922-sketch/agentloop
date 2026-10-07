/** Page-owned conversation index state. Message projection and rendering stay outside this module. */
export function createConversationState(pageSize = 30) {
  return {
    recovered: [],
    sessions: [],
    activeId: undefined,
    visibleLimit: pageSize,
    nextOffset: 0,
    hasMore: false,
    loadingMore: false,
    resetPaging() {
      this.visibleLimit = pageSize;
      this.nextOffset = 0;
      this.hasMore = false;
      this.loadingMore = false;
    },
    clear() {
      this.recovered = [];
      this.sessions = [];
      this.activeId = undefined;
      this.resetPaging();
    },
  };
}
