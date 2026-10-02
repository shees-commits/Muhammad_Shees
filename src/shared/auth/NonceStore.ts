/** Port for the replay-protection ledger. */
export interface NonceStore {
  /**
   * Atomically records (sub, nonce). Returns true on first use, false if the
   * pair was already recorded (a replay).
   */
  consume(sub: string, nonce: string, expiresAt: Date): Promise<boolean>;
  /** Deletes entries whose timestamp window has passed; returns how many were removed. */
  purgeExpired(now: Date): Promise<number>;
}
