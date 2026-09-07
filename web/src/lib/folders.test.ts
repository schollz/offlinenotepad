import { describe, expect, it } from 'vitest'
import type { FolderContent } from '../types'
import { canMoveFolder, descendantFolderIds, flattenedFolders, folderNameError, folderPath } from './folders'

const timestamp = '2026-01-01T00:00:00Z'
const folders: FolderContent[] = [
  { record_type: 'folder', id: 'projects', name: 'Projects', parent_id: null, created_at: timestamp, updated_at: timestamp },
  { record_type: 'folder', id: 'archive', name: 'Archive', parent_id: 'projects', created_at: timestamp, updated_at: timestamp },
  { record_type: 'folder', id: 'ideas', name: 'Ideas', parent_id: null, created_at: timestamp, updated_at: timestamp },
]

describe('folder hierarchy helpers', () => {
  it('builds readable paths and a stable parent-first tree', () => {
    expect(folderPath('archive', folders)).toBe('Projects / Archive')
    expect(folderPath(null, folders)).toBe('Notes')
    expect(flattenedFolders(folders).map(({ folder, depth }) => [folder.id, depth])).toEqual([
      ['ideas', 0], ['projects', 0], ['archive', 1],
    ])
  })

  it('finds descendants and prevents hierarchy cycles', () => {
    expect([...descendantFolderIds('projects', folders)]).toEqual(['projects', 'archive'])
    expect(canMoveFolder('projects', 'archive', folders)).toBe(false)
    expect(canMoveFolder('archive', 'ideas', folders)).toBe(true)
  })

  it('validates names within a sibling group', () => {
    expect(folderNameError(' projects ', null, folders)).toMatch(/already exists/i)
    expect(folderNameError('Projects', 'ideas', folders)).toBe('')
    expect(folderNameError('../private', null, folders)).toMatch(/slashes/i)
    expect(folderNameError('  ', null, folders)).toMatch(/enter/i)
    expect(folderNameError('Projects', null, folders, 'projects')).toBe('')
  })
})
