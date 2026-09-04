// Type declaration for the plain-JS http-host-throttle.js (see SOURCES.md).
export function throttleByHost(...args: any[]): any;
export function throttledFetchJson(...args: any[]): Promise<any>;
export function safeFetchJson(...args: any[]): Promise<any>;
export function delay(ms: number): Promise<void>;
export const HOST_MIN_INTERVAL_MS: number;
