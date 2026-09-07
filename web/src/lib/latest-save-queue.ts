interface Entry<T> {
  value: T
  running?: Promise<void>
  failed: boolean
}

/** Immediately saves, retaining only the newest waiting version of each record. */
export class LatestSaveQueue<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private closed = false

  constructor(private readonly save: (value: T) => Promise<void>, private readonly changed: () => void) {}

  get pending(): boolean { return this.entries.size > 0 }
  get failed(): boolean { return [...this.entries.values()].some((entry) => entry.failed) }
  has(key: string): boolean { return this.entries.has(key) }

  enqueue(key: string, value: T): void {
    if (this.closed) return
    const entry = this.entries.get(key) ?? { value, failed: false }
    entry.value = value
    entry.failed = false
    this.entries.set(key, entry)
    this.start(key, entry)
    this.changed()
  }

  private start(key: string, entry: Entry<T>): void {
    if (entry.running) return
    entry.failed = false
    entry.running = Promise.resolve().then(async () => {
      while (!this.closed && this.entries.get(key) === entry) {
        const value = entry.value
        try {
          await this.save(value)
        } catch {
          entry.failed = true
          break
        }
        if (entry.value === value) {
          if (this.entries.get(key) === entry) this.entries.delete(key)
          break
        }
      }
    }).finally(() => {
      entry.running = undefined
      if (!this.closed) this.changed()
    })
  }

  async drain(): Promise<void> {
    for (const [key, entry] of this.entries) this.start(key, entry)
    while ([...this.entries.values()].some((entry) => entry.running)) {
      await Promise.all([...this.entries.values()].map((entry) => entry.running))
    }
    if (this.closed || this.failed) throw new Error('Local save unavailable')
  }

  async cancel(key: string): Promise<void> {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    await entry?.running
    this.changed()
  }

  close(): void {
    this.closed = true
    this.entries.clear()
  }
}
