import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileTree } from './FileTree'

describe('file tree root', () => {
  it('uses the Files heading as the top-level control without a redundant Notes row', () => {
    const onSelectFolder = vi.fn()
    render(<FileTree
      notes={[]}
      folders={[]}
      selectedNoteId=""
      activeFolderId={null}
      search=""
      onSelectNote={vi.fn()}
      onSelectFolder={onSelectFolder}
      onNewNote={vi.fn()}
      onNewFolder={vi.fn()}
      onRenameFolder={vi.fn()}
      onMoveNote={vi.fn()}
      onMoveFolder={vi.fn()}
      onDeleteNote={vi.fn()}
      onDeleteFolder={vi.fn()}
      onDropItem={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Show top-level files' }))

    expect(onSelectFolder).toHaveBeenCalledWith(null)
    expect(screen.queryByText('Notes')).not.toBeInTheDocument()
  })
})
