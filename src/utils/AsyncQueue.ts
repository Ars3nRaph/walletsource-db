/**
 * Simple async queue to limit concurrent operations.
 * Prevents overwhelming external APIs with simultaneous requests.
 */
export class AsyncQueue {
  private running = 0;

  constructor(private concurrency: number) {}

  async add<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.concurrency) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
    }
  }

  getRunning(): number {
    return this.running;
  }
}
