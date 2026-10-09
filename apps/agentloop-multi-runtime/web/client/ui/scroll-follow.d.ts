export interface ScrollMetrics {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

export declare function isNearBottom(metrics: ScrollMetrics, threshold?: number): boolean;
export declare function nextScrollTop(metrics: ScrollMetrics, shouldFollow: boolean, previousScrollTop?: number): number;
