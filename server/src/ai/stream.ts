/**
 * A model call that pushes text as it arrives and resolves with the parsed output.
 * The producer runs even if nobody reads `deltas`, so a JSON client can await
 * `output` alone. Reading `deltas` never delays `output`.
 */
export interface AiTextStream<T> {
  deltas: AsyncIterable<string>;
  output: Promise<T>;
}

export interface ReplayLog<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
}

/** Append-only items that every reader gets from the start, then live until `close`. Late readers catch up. */
export function replayLog<T>(): ReplayLog<T> {
  const items: T[] = [];
  let closed = false;
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  return {
    push(item) {
      items.push(item);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      let index = 0;
      while (true) {
        while (index < items.length) yield items[index++]!;
        if (closed) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

export function modelStream<T>(produce: (emit: (delta: string) => void) => Promise<T>): AiTextStream<T> {
  const deltas = replayLog<string>();
  const output = produce((delta) => {
    if (delta.length > 0) deltas.push(delta);
  }).finally(() => deltas.close());
  // A caller that only iterates deltas, or that disconnects, must not leave the rejection unhandled.
  // Awaiters of `output` still observe it.
  void output.catch(() => {});
  return { deltas, output };
}
