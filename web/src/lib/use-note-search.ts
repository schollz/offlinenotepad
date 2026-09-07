import { useEffect, useRef, useState } from 'react'
import type { FolderContent, NoteContent } from '../types'
import { folderPath } from './folders'
import type { SearchDocument } from './search-index'

export function useNoteSearch(notes: Array<{ note: NoteContent }>, folders: FolderContent[], query: string, workspace?: string): Set<string> | null {
  const worker = useRef<Worker | null>(null)
  const indexed = useRef(new Map<string, SearchDocument>())
  const sequence = useRef(0)
  const [result, setResult] = useState<{ query: string; ids: Set<string> } | null>(null)
  const latestQuery = useRef(query)
  latestQuery.current = query

  useEffect(() => {
    if (!workspace) return
    const current = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
    worker.current = current
    indexed.current.clear()
    current.onmessage = (event: MessageEvent<{ id: number; ids: string[] }>) => {
      if (event.data.id === sequence.current) setResult({ query: latestQuery.current, ids: new Set(event.data.ids) })
    }
    return () => {
      current.terminate()
      worker.current = null
      indexed.current.clear()
      current.onmessage = null
    }
  }, [workspace])

  useEffect(() => {
    if (!worker.current) return
    const id = ++sequence.current
    const update = () => {
      const next = new Map<string, SearchDocument>()
      const upsert: SearchDocument[] = []
      for (const { note } of notes) {
        const old = indexed.current.get(note.id)
        const folder = folderPath(note.folder_id, folders)
        const document = old && old.title === note.title && old.content === note.content && old.folder === folder
          ? old : { id: note.id, title: note.title, content: note.content, folder }
        next.set(note.id, document)
        if (old !== document) upsert.push(document)
      }
      const remove = [...indexed.current.keys()].filter((key) => !next.has(key))
      indexed.current = next
      worker.current?.postMessage({ upsert, remove, ...(query.trim() ? { query, id } : {}) })
    }
    // Searching flushes indexing immediately; background edits can coalesce.
    const timer = window.setTimeout(update, query.trim() ? 0 : 150)
    return () => window.clearTimeout(timer)
  }, [notes, folders, query, workspace])

  return query.trim() ? result?.query === query ? result.ids : new Set() : null
}
