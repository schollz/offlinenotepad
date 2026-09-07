import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ChevronRight,
  Cloud,
  CloudOff,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPen,
  FolderPlus,
  MoreHorizontal,
  Move,
  Trash2,
} from 'lucide-react'
import { folderById, folderPath } from '../lib/folders'
import type { FolderContent, NoteContent, StoredDocument } from '../types'

export interface FileTreeNote {
  note: NoteContent
  stored: StoredDocument
}

type DraggedItem = { kind: 'note' | 'folder'; id: string }

interface FileTreeProps {
  notes: FileTreeNote[]
  folders: FolderContent[]
  selectedNoteId: string
  selectedNoteIds: ReadonlySet<string>
  activeFolderId: string | null
  search: string
  onSelectNotes: (ids: string[], activeId: string) => void
  onClearNoteSelection: () => void
  onSelectFolder: (id: string | null) => void
  onNewNote: (folderId: string | null) => void
  onNewFolder: (parentId: string | null) => void
  onRenameFolder: (id: string) => void
  onMoveNote: (id: string) => void
  onMoveNotes: (ids: string[]) => void
  onMoveFolder: (id: string) => void
  onDeleteNote: (id: string) => void
  onDeleteNotes: (ids: string[]) => void
  onDeleteFolder: (id: string) => void
  onDropItem: (item: DraggedItem, folderId: string | null) => void
}

function readDraggedItem(event: DragEvent): DraggedItem | null {
  try {
    const value = JSON.parse(event.dataTransfer.getData('application/x-offlinenotepad-item')) as DraggedItem
    return (value.kind === 'note' || value.kind === 'folder') && typeof value.id === 'string' ? value : null
  } catch {
    return null
  }
}

function startDrag(event: DragEvent, item: DraggedItem): void {
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-offlinenotepad-item', JSON.stringify(item))
}

function dropOnFolder(event: DragEvent, folderId: string | null, onDrop: FileTreeProps['onDropItem']): void {
  event.preventDefault()
  const item = readDraggedItem(event)
  if (item) onDrop(item, folderId)
}

export function FileTree(props: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined)
  const knownFolders = useRef(new Set<string>())
  const selectionAnchor = useRef<string | null>(null)
  const menuRoot = useRef<HTMLDivElement>(null)
  const byId = useMemo(() => folderById(props.folders), [props.folders])

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current)
      for (const folder of props.folders) {
        if (!knownFolders.current.has(folder.id)) next.add(folder.id)
      }
      knownFolders.current = new Set(props.folders.map((folder) => folder.id))
      return next
    })
  }, [props.folders])

  useEffect(() => {
    const selected = props.notes.find(({ note }) => note.id === props.selectedNoteId)?.note
    let parentId = selected?.folder_id ?? props.activeFolderId
    if (!parentId) return
    setExpanded((current) => {
      const next = new Set(current)
      const visited = new Set<string>()
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId)
        next.add(parentId)
        parentId = byId.get(parentId)?.parent_id ?? null
      }
      return next
    })
  }, [byId, props.activeFolderId, props.notes, props.selectedNoteId])

  useEffect(() => {
    if (props.selectedNoteIds.size <= 1) selectionAnchor.current = props.selectedNoteId || null
  }, [props.selectedNoteId, props.selectedNoteIds.size])

  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const childFolders = useMemo(() => {
    const groups = new Map<string | null, FolderContent[]>()
    const ids = new Set(props.folders.map((folder) => folder.id))
    for (const folder of props.folders) {
      const parentId = folder.parent_id && ids.has(folder.parent_id) ? folder.parent_id : null
      groups.set(parentId, [...(groups.get(parentId) ?? []), folder])
    }
    for (const group of groups.values()) {
      group.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true }))
    }
    return groups
  }, [props.folders])

  const childNotes = useMemo(() => {
    const groups = new Map<string | null, FileTreeNote[]>()
    const ids = new Set(props.folders.map((folder) => folder.id))
    for (const note of props.notes) {
      const folderId = note.note.folder_id && ids.has(note.note.folder_id) ? note.note.folder_id : null
      groups.set(folderId, [...(groups.get(folderId) ?? []), note])
    }
    for (const group of groups.values()) {
      group.sort((left, right) => (left.note.title || 'Untitled note').localeCompare(
        right.note.title || 'Untitled note', undefined, { sensitivity: 'base', numeric: true },
      ))
    }
    return groups
  }, [props.folders, props.notes])

  const folderNoteCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { note } of props.notes) {
      const visited = new Set<string>()
      let folderId = note.folder_id ?? null
      while (folderId && !visited.has(folderId)) {
        visited.add(folderId)
        counts.set(folderId, (counts.get(folderId) ?? 0) + 1)
        folderId = byId.get(folderId)?.parent_id ?? null
      }
    }
    return counts
  }, [byId, props.notes])

  const visibleNoteIds = useMemo(() => {
    if (props.search.trim()) return props.notes.map(({ note }) => note.id)
    const result: string[] = []
    const appendFolder = (folder: FolderContent) => {
      if (!expanded.has(folder.id)) return
      for (const child of childFolders.get(folder.id) ?? []) appendFolder(child)
      for (const { note } of childNotes.get(folder.id) ?? []) result.push(note.id)
    }
    for (const folder of childFolders.get(null) ?? []) appendFolder(folder)
    for (const { note } of childNotes.get(null) ?? []) result.push(note.id)
    return result
  }, [childFolders, childNotes, expanded, props.notes, props.search])

  const selectNote = (event: MouseEvent<HTMLButtonElement>, id: string) => {
    if (!event.shiftKey) {
      selectionAnchor.current = id
      props.onSelectNotes([id], id)
      return
    }
    const fallbackAnchor = visibleNoteIds.includes(props.selectedNoteId) ? props.selectedNoteId : id
    const anchor = selectionAnchor.current && visibleNoteIds.includes(selectionAnchor.current)
      ? selectionAnchor.current
      : fallbackAnchor
    const anchorIndex = visibleNoteIds.indexOf(anchor)
    const selectedIndex = visibleNoteIds.indexOf(id)
    if (anchorIndex < 0 || selectedIndex < 0) {
      props.onSelectNotes([id], id)
      return
    }
    const start = Math.min(anchorIndex, selectedIndex)
    const end = Math.max(anchorIndex, selectedIndex)
    props.onSelectNotes(visibleNoteIds.slice(start, end + 1), id)
  }

  const closeMenu = (action: () => void) => {
    setMenu(null)
    action()
  }

  const itemMenu = (id: string, children: ReactNode) => (
    <div className="tree-item-menu" ref={menu === id ? menuRoot : undefined}>
      <button
        className="tree-more"
        aria-label="More actions"
        aria-expanded={menu === id}
        onClick={(event) => { event.stopPropagation(); setMenu(menu === id ? null : id) }}
      ><MoreHorizontal /></button>
      {menu === id && <div className="tree-menu-popover" role="menu">{children}</div>}
    </div>
  )

  const noteRow = ({ note, stored }: FileTreeNote, depth: number, showPath = false) => {
    const title = note.title || 'Untitled note'
    const selected = props.selectedNoteIds.has(note.id)
    const selectedIds = [...props.selectedNoteIds]
    const useSelection = selected && selectedIds.length > 1
    return <div className="tree-row-wrap" key={note.id} style={{ '--tree-depth': depth } as CSSProperties}>
      <button
        className={`tree-row note-tree-row note-row ${selected ? 'selected' : ''} ${note.id === props.selectedNoteId ? 'active-note' : ''}`}
        aria-pressed={selected}
        draggable
        onDragStart={(event) => startDrag(event, { kind: 'note', id: note.id })}
        onClick={(event) => selectNote(event, note.id)}
        title={showPath ? `${title} — ${folderPath(note.folder_id, props.folders)}` : title}
      >
        <FileText className="tree-item-icon" />
        <span className="tree-label"><span className="note-title">{title}</span>{showPath && <small>{folderPath(note.folder_id, props.folders)}</small>}</span>
        <span className="tree-sync" title={stored.pending ? 'Saved offline' : 'Synchronized'}>{stored.pending ? <CloudOff /> : <Cloud />}</span>
      </button>
      {itemMenu(`note:${note.id}`, <>
        <button role="menuitem" onClick={() => closeMenu(() => useSelection ? props.onMoveNotes(selectedIds) : props.onMoveNote(note.id))}><Move /> {useSelection ? `Move ${selectedIds.length} notes…` : 'Move note…'}</button>
        <button role="menuitem" className="danger" onClick={() => closeMenu(() => useSelection ? props.onDeleteNotes(selectedIds) : props.onDeleteNote(note.id))}><Trash2 /> {useSelection ? `Delete ${selectedIds.length} notes` : 'Delete note'}</button>
      </>)}
    </div>
  }

  const selectionActions = props.selectedNoteIds.size > 1 && <div className="tree-selection-actions" role="toolbar" aria-label={`${props.selectedNoteIds.size} selected notes`}>
    <span>{props.selectedNoteIds.size} selected</span>
    <button onClick={() => props.onMoveNotes([...props.selectedNoteIds])} title="Move selected notes"><Move /><span>Move</span></button>
    <button className="danger" onClick={() => props.onDeleteNotes([...props.selectedNoteIds])} title="Delete selected notes"><Trash2 /><span>Delete</span></button>
    <button className="clear-selection" onClick={props.onClearNoteSelection} aria-label="Clear note selection" title="Clear selection">×</button>
  </div>

  const folderRow = (folder: FolderContent, depth: number): ReactNode => {
    const open = expanded.has(folder.id)
    const itemCount = (childNotes.get(folder.id)?.length ?? 0) + (childFolders.get(folder.id)?.length ?? 0)
    const noteCount = folderNoteCounts.get(folder.id) ?? 0
    return <div key={folder.id}>
      <div
        className={`tree-row-wrap folder-drop ${dropTarget === folder.id ? 'drop-target' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(folder.id) }}
        onDragLeave={() => setDropTarget(undefined)}
        onDrop={(event) => { setDropTarget(undefined); dropOnFolder(event, folder.id, props.onDropItem) }}
      >
        <button
          className="tree-toggle"
          onClick={() => setExpanded((current) => {
            const next = new Set(current)
            if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id)
            return next
          })}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
          aria-expanded={open}
        ><ChevronRight className={open ? 'open' : ''} /></button>
        <button
          className={`tree-row folder-tree-row ${props.activeFolderId === folder.id ? 'active' : ''}`}
          draggable
          onDragStart={(event) => startDrag(event, { kind: 'folder', id: folder.id })}
          onClick={() => {
            props.onSelectFolder(folder.id)
            if (!open && itemCount) setExpanded((current) => new Set(current).add(folder.id))
          }}
          title={folderPath(folder.id, props.folders)}
        >
          {open ? <FolderOpen className="tree-item-icon" /> : <Folder className="tree-item-icon" />}
          <span className="tree-label"><span>{folder.name}</span></span>
          {noteCount > 0 && <span className="tree-count">{noteCount}</span>}
        </button>
        {itemMenu(`folder:${folder.id}`, <>
          <button role="menuitem" onClick={() => closeMenu(() => props.onNewNote(folder.id))}><FilePlus2 /> New note</button>
          <button role="menuitem" onClick={() => closeMenu(() => props.onNewFolder(folder.id))}><FolderPlus /> New subfolder</button>
          <button role="menuitem" onClick={() => closeMenu(() => props.onRenameFolder(folder.id))}><FolderPen /> Rename</button>
          <button role="menuitem" onClick={() => closeMenu(() => props.onMoveFolder(folder.id))}><Move /> Move folder…</button>
          <button role="menuitem" className="danger" onClick={() => closeMenu(() => props.onDeleteFolder(folder.id))}><Trash2 /> Delete folder</button>
        </>)}
      </div>
      {open && <div>
        {(childFolders.get(folder.id) ?? []).map((child) => folderRow(child, depth + 1))}
        {(childNotes.get(folder.id) ?? []).map((note) => noteRow(note, depth + 1))}
      </div>}
    </div>
  }

  if (props.search.trim()) {
    return <nav className="file-tree search-tree" aria-label="Search results">
      {selectionActions}
      <div className="tree-section-label">{props.notes.length} result{props.notes.length === 1 ? '' : 's'}</div>
      {props.notes.map((note) => noteRow(note, 0, true))}
      {!props.notes.length && <div className="empty-list"><FileText /><span>No matching notes</span></div>}
    </nav>
  }

  return <nav className="file-tree" aria-label="Files and folders">
    {selectionActions}
    <button
      className={`tree-section-label tree-root-label ${dropTarget === null ? 'drop-target' : ''}`}
      aria-label="Show top-level files"
      title="Show top-level files"
      onClick={() => props.onSelectFolder(null)}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(null) }}
      onDragLeave={() => setDropTarget(undefined)}
      onDrop={(event) => { setDropTarget(undefined); dropOnFolder(event, null, props.onDropItem) }}
    >Files</button>
    {(childFolders.get(null) ?? []).map((folder) => folderRow(folder, 0))}
    {(childNotes.get(null) ?? []).map((note) => noteRow(note, 0))}
    {!props.notes.length && !props.folders.length && <div className="empty-list"><FileText /><span>Your notes and folders will appear here</span></div>}
  </nav>
}
