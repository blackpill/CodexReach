export class QueueRunner {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private failures = 0;
  constructor(
    private client: { poll(): Promise<void> },
    private intervalMs = 10_000,
    private onError: (error: unknown) => void = () => {},
    private random: () => number = Math.random,
  ) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  private async tick(): Promise<void> {
    try {
      await this.client.poll();
      this.failures = 0;
    } catch (error) {
      this.failures++;
      this.onError(error);
    }
    if (!this.stopped) {
      const base = Math.min(this.intervalMs * 2 ** Math.min(this.failures, 6), 600_000);
      this.timer = setTimeout(() => void this.tick(), base * (0.9 + this.random() * 0.2));
    }
  }
}
