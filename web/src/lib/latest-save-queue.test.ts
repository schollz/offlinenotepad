import { describe, expect, it, vi } from 'vitest'
import { LatestSaveQueue } from './latest-save-queue'

function gate() {
  let release!: () => void
  return { promise: new Promise<void>((resolve) => { release = resolve }), release: () => release() }
}

describe('latest local save queue', () => {
  it('bounds queued work while retaining the latest version', async () => {
    const first = gate()
    const saved: number[] = []
    const queue = new LatestSaveQueue<number>(async (value) => { saved.push(value); if (value === 0) await first.promise }, vi.fn())
    queue.enqueue('note', 0)
    await Promise.resolve()
    for (let i = 1; i <= 1000; i++) queue.enqueue('note', i)
    expect(saved).toEqual([0])
    first.release()
    await queue.drain()
    expect(saved).toEqual([0, 1000])
    expect(queue.pending).toBe(false)
  })

  it('keeps failed edits for explicit retry and makes drains fail', async () => {
    const save = vi.fn().mockRejectedValue(new Error('quota'))
    const queue = new LatestSaveQueue(save, vi.fn())
    queue.enqueue('note', 'latest')
    await expect(queue.drain()).rejects.toThrow('Local save unavailable')
    expect(queue.pending).toBe(true)
    expect(queue.failed).toBe(true)
    save.mockResolvedValue(undefined)
    await queue.drain()
    expect(save).toHaveBeenLastCalledWith('latest')
    expect(queue.pending).toBe(false)
  })

  it('waits for an active write before deletion and discards its waiting version', async () => {
    const first = gate()
    const events: string[] = []
    const queue = new LatestSaveQueue<string>(async (value) => { await first.promise; events.push(value) }, vi.fn())
    queue.enqueue('note', 'first')
    await Promise.resolve()
    queue.enqueue('note', 'obsolete')
    const deletion = queue.cancel('note').then(() => events.push('deleted'))
    first.release()
    await deletion
    expect(events).toEqual(['first', 'deleted'])
    expect(queue.pending).toBe(false)
  })

  it('does not persist queued work after session teardown', async () => {
    const save = vi.fn()
    const queue = new LatestSaveQueue(save, vi.fn())
    queue.enqueue('note', 'private')
    queue.close()
    await Promise.resolve()
    expect(save).not.toHaveBeenCalled()
  })
})
