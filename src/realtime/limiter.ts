/** Per-socket token bucket. Refills `rate` tokens per second up to `burst`. */
export function tokenBucket(rate: number, burst: number) {
  let tokens = burst;
  let last = Date.now();
  return {
    take(): boolean {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
