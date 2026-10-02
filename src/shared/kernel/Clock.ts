/** Time source port. Injected everywhere "now" matters so tests can control time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
