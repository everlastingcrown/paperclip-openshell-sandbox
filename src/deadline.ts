import { setTimeout as delay } from 'node:timers/promises';
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const systemClock: Clock = { now: Date.now, sleep: delay };
export function remaining(deadline: number, clock: Clock = systemClock) {
  const ms = deadline - clock.now();
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error('Operation deadline exceeded');
  return ms;
}
