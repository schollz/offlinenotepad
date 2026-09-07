import { describe, expect, it } from 'vitest'
import { SearchIndex } from './search-index'
import { publicationURL } from './publication'

describe('incremental notebook search', () => {
  it('updates titles, bodies, and folder paths without losing other notes', () => {
    const index = new SearchIndex()
    index.apply({ upsert: [
      { id: 'one', title: 'Alpha', content: 'first text', folder: 'Work' },
      { id: 'two', title: 'Beta', content: 'second text', folder: 'Home' },
    ] })
    expect(index.apply({ query: 'first' })).toEqual(['one'])
    index.apply({ upsert: [{ id: 'one', title: 'Gamma', content: 'replacement', folder: 'Archive' }] })
    expect(index.apply({ query: 'first' })).toEqual([])
    expect(index.apply({ query: 'Archive' })).toEqual(['one'])
    expect(index.apply({ query: 'second' })).toEqual(['two'])
    index.apply({ remove: ['one'] })
    expect(index.apply({ query: 'Gamma' })).toEqual([])
  })
})

it('preserves legacy public URLs', () => {
  expect(publicationURL({ public_id: 'abcd1234' })).toBe('/abcd1234')
  expect(publicationURL({ public_id: 'modern-public-id-123' })).toBe('/p/modern-public-id-123')
})
