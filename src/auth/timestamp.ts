// Replay protection via clock-skew check.

export function isTimestampFresh(
  raw: string | undefined,
  toleranceSec: number,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!raw) return false;
  const ts = Number.parseInt(raw, 10);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(now - ts) <= toleranceSec;
}
