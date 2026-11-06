const HOUR_MS = 3_600_000;
const hourInBeijing = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
});
const hour = (at: number) => Number(hourInBeijing.format(at));
const allowedHour = (at: number) => hour(at) >= 7 && hour(at) <= 22;

// The minute tick may run a few seconds after 22:00; allow that final slot,
// but do not start a missed check later in the night. Already-started scans finish.
export function canCheckNow(at: number): boolean {
  const h = hour(at);
  return h >= 7 && (h < 22 || (h === 22 && at % HOUR_MS < 60_000));
}

export function nextCheckAt(at: number): number {
  let next = (Math.floor(at / HOUR_MS) + 1) * HOUR_MS;
  while (!allowedHour(next)) next += HOUR_MS;
  return next;
}

// Preserve existing baselines and watermarks when upgrading from interval polling.
export function normalizeCheckAt(at: number): number {
  if (at === 0) return 0;
  let next = Math.ceil(at / HOUR_MS) * HOUR_MS;
  while (!allowedHour(next)) next += HOUR_MS;
  return next;
}
