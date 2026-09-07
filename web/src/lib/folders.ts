import type { FolderContent } from '../types'

export interface FolderTreeEntry {
  folder: FolderContent
  depth: number
}

export function folderNameError(
  value: string,
  parentId: string | null,
  folders: FolderContent[],
  currentId?: string,
): string {
  const name = value.trim()
  if (!name) return 'Enter a folder name.'
  if (name.length > 120) return 'Folder names must be 120 characters or fewer.'
  if (name === '.' || name === '..') return 'Choose a more descriptive folder name.'
  if (/[\\/]/u.test(name)) return 'Folder names cannot contain slashes.'
  const duplicate = folders.some((folder) => (
    folder.id !== currentId
    && folder.parent_id === parentId
    && folder.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
  ))
  return duplicate ? 'A folder with this name already exists here.' : ''
}

export function folderById(folders: FolderContent[]): Map<string, FolderContent> {
  return new Map(folders.map((folder) => [folder.id, folder]))
}

export function folderPath(folderId: string | null | undefined, folders: FolderContent[]): string {
  if (!folderId) return 'Notes'
  const byId = folderById(folders)
  const names: string[] = []
  const visited = new Set<string>()
  let current = byId.get(folderId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    names.unshift(current.name)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return names.length ? names.join(' / ') : 'Notes'
}

export function descendantFolderIds(folderId: string, folders: FolderContent[]): Set<string> {
  const descendants = new Set([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parent_id && descendants.has(folder.parent_id) && !descendants.has(folder.id)) {
        descendants.add(folder.id)
        changed = true
      }
    }
  }
  return descendants
}

export function canMoveFolder(folderId: string, parentId: string | null, folders: FolderContent[]): boolean {
  return !parentId || !descendantFolderIds(folderId, folders).has(parentId)
}

function compareFolders(left: FolderContent, right: FolderContent): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
}

export function flattenedFolders(folders: FolderContent[]): FolderTreeEntry[] {
  const children = new Map<string | null, FolderContent[]>()
  for (const folder of folders) {
    const parent = folders.some((candidate) => candidate.id === folder.parent_id) ? folder.parent_id : null
    children.set(parent, [...(children.get(parent) ?? []), folder])
  }
  for (const group of children.values()) group.sort(compareFolders)
  const rows: FolderTreeEntry[] = []
  const visited = new Set<string>()
  const append = (parentId: string | null, depth: number) => {
    for (const folder of children.get(parentId) ?? []) {
      if (visited.has(folder.id)) continue
      visited.add(folder.id)
      rows.push({ folder, depth })
      append(folder.id, depth + 1)
    }
  }
  append(null, 0)
  for (const folder of [...folders].sort(compareFolders)) {
    if (!visited.has(folder.id)) rows.push({ folder, depth: 0 })
  }
  return rows
}
