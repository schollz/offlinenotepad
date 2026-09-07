import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileTree, type FileTreeNote } from './FileTree'

function treeNote(id: string, title: string): FileTreeNote {
  const timestamp = '2026-09-06T12:00:00.000Z'
  return {
    note: { id, title, content: '', mode: 'markdown', folder_id: null, created_at: timestamp, updated_at: timestamp },
    stored: {
      key: `workspace:${id}`, workspaceId: 'workspace', documentId: id, ciphertext: 'encrypted', ciphertextHash: 'hash',
      revision: 1, deleted: false, updatedAt: timestamp, pending: false,
    },
  }
}

function props(overrides: Partial<Parameters<typeof FileTree>[0]> = {}): Parameters<typeof FileTree>[0] {
  return {
    notes: [], folders: [], selectedNoteId: '', selectedNoteIds: new Set(), activeFolderId: null, search: '',
    onSelectNotes: vi.fn(), onClearNoteSelection: vi.fn(), onSelectFolder: vi.fn(), onNewNote: vi.fn(),
    onNewFolder: vi.fn(), onRenameFolder: vi.fn(), onMoveNote: vi.fn(), onMoveNotes: vi.fn(),
    onMoveFolder: vi.fn(), onDeleteNote: vi.fn(), onDeleteNotes: vi.fn(), onDeleteFolder: vi.fn(), onDropItem: vi.fn(),
    ...overrides,
  }
}

describe('file tree root', () => {
  it('uses the Files heading as the top-level control without a redundant Notes row', () => {
    const onSelectFolder = vi.fn()
    render(<FileTree {...props({ onSelectFolder })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show top-level files' }))

    expect(onSelectFolder).toHaveBeenCalledWith(null)
    expect(screen.queryByText('Notes')).not.toBeInTheDocument()
  })

  it('selects the visible note range while Shift is held', () => {
    const onSelectNotes = vi.fn()
    render(<FileTree {...props({
      notes: [treeNote('charlie', 'Charlie'), treeNote('alpha', 'Alpha'), treeNote('bravo', 'Bravo')],
      onSelectNotes,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Charlie' }), { shiftKey: true })

    expect(onSelectNotes).toHaveBeenNthCalledWith(1, ['alpha'], 'alpha')
    expect(onSelectNotes).toHaveBeenNthCalledWith(2, ['alpha', 'bravo', 'charlie'], 'charlie')
  })

  it('offers bulk actions for the selected notes', () => {
    const onMoveNotes = vi.fn()
    const onDeleteNotes = vi.fn()
    const onClearNoteSelection = vi.fn()
    render(<FileTree {...props({
      notes: [treeNote('alpha', 'Alpha'), treeNote('bravo', 'Bravo')],
      selectedNoteId: 'alpha', selectedNoteIds: new Set(['alpha', 'bravo']),
      onMoveNotes, onDeleteNotes, onClearNoteSelection,
    })} />)

    expect(screen.getByRole('toolbar', { name: '2 selected notes' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear note selection' }))

    expect(onMoveNotes).toHaveBeenCalledWith(['alpha', 'bravo'])
    expect(onDeleteNotes).toHaveBeenCalledWith(['alpha', 'bravo'])
    expect(onClearNoteSelection).toHaveBeenCalledOnce()
  })
})
