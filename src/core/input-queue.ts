// An async iterable the caller pushes to: the streaming input of a query(). The
// SDK reads the next message as soon as it is pushed, also while a turn runs, so
// messages sent mid-turn reach Claude Code at once and it queues them itself.

export class InputQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private ended = false

  push(value: T): void {
    if (this.ended) throw new Error('Input queue has ended')
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value, done: false })
    } else {
      this.buffer.push(value)
    }
  }

  end(): void {
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.buffer.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}
