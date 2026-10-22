import { setTimeout as delay } from 'node:timers/promises';
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const systemClock: Clock = { now: Date.now, sleep: delay };
export class OperationDeadlineError extends Error {
  constructor() {
    super('Operation deadline exceeded');
  }
}
export function remaining(deadline: number, clock: Clock = systemClock) {
  const ms = deadline - clock.now();
  if (!Number.isFinite(ms) || ms <= 0) throw new OperationDeadlineError();
  return ms;
}
