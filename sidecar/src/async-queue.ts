/**
 * Minimale async Queue, die als prompt-AsyncIterable für query() dient.
 * push() reicht User-Messages an den laufenden Agenten; close() beendet den Stream.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(v: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.items.push(value);
  }

  close(): void {
    this.done = true;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const item = this.items.shift();
          if (item !== undefined) resolve({ value: item, done: false });
          else if (this.done) resolve({ value: undefined as never, done: true });
          else this.waiters.push(resolve);
        }),
    };
  }
}
