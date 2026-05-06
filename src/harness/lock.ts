/**
 * Resource concurrency lock.
 *
 * Provides a simple per-key locking mechanism using a Map<string, Promise<void>>.
 * Ensures that operations on the same resource key are serialised without
 * blocking operations on different keys.
 *
 * Pattern: each acquire() for a key waits for the previous holder's release
 * before granting access. Releases are FIFO per-key.
 *
 * Example:
 * ```
 * const lock = new ResourceLock();
 * const release = await lock.acquire("session:abc123");
 * try { /* do work *\/ } finally { release(); }
 * ```
 */

export class ResourceLock {
  /** Map of key → promise that resolves when the lock is free */
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire an exclusive lock for the given key.
   *
   * Returns a release function. Call it when done (ideally in a finally block).
   * If the key is already held, the caller waits until the previous holder
   * calls release.
   */
  async acquire(key: string): Promise<() => void> {
    // Previous lock (or Promise.resolve() if none)
    const prev = this.locks.get(key) ?? Promise.resolve();

    // Create a new promise whose resolve will be the release function
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(key, next);

    // Wait for previous holder to finish
    await prev;

    return () => {
      release!();       // unblock the next waiter
      // Clean up if this is the tail
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    };
  }

  /**
   * Check whether a specific key is currently locked.
   * This is best-effort — the lock may be released before checking completes.
   */
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  /**
   * Return the number of currently held locks (for monitoring/health checks).
   */
  get size(): number {
    return this.locks.size;
  }
}
