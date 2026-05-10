// Fixed-window per-device rate limiter. In-memory; per-process.
// One window = 60 seconds. Counter resets at window boundary.

interface Window {
  start: number; // unix seconds
  count: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  constructor(private readonly limitPerMinute: number) {}

  hit(key: string, now: number = Math.floor(Date.now() / 1000)): boolean {
    const windowStart = now - (now % 60);
    const w = this.windows.get(key);
    if (!w || w.start !== windowStart) {
      this.windows.set(key, { start: windowStart, count: 1 });
      return true;
    }
    if (w.count >= this.limitPerMinute) return false;
    w.count++;
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}
