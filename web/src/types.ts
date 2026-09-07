export type ContentMode = 'markdown' | 'plaintext'
export type PublicationRenderMode = 'document' | 'html' | 'markdown-html'

export interface KdfMetadata {
  id: string
  kdf_version: number
  kdf_salt: string
  kdf_memory: number
  kdf_iterations: number
  kdf_parallelism: number
  auth_public_key: string
}

export interface NoteContent {
  id: string
  title: string
  content: string
  mode: ContentMode
  folder_id?: string | null
  created_at: string
  updated_at: string
}

export interface FolderContent {
  record_type: 'folder'
  id: string
  name: string
  parent_id: string | null
  created_at: string
  updated_at: string
}

export interface WorkspacePreferences {
  record_type: 'workspace_preferences'
  id: string
  last_opened_note_id: string
  updated_at: string
}

export type PrivateRecord = NoteContent | FolderContent | WorkspacePreferences

export interface StoredDocument {
  key: string
  workspaceId: string
  documentId: string
  ciphertext: string
  ciphertextHash: string
  revision: number
  deleted: boolean
  updatedAt: string
  pending: boolean
}

export interface OutboxEntry {
  id?: number
  key: string
  workspaceId: string
  documentId: string
  operation: 'upsert' | 'delete'
  ciphertext: string
  ciphertextHash: string
  baseRevision: number
  createdAt: string
  sentMutation?: {
    operation: 'upsert' | 'delete'
    ciphertextHash: string
    baseRevision: number
  }
}

export interface Publication {
  public_id: string
  document_id: string
  title: string
  content: string
  content_mode: ContentMode
  render_mode?: PublicationRenderMode
  legacy: boolean
  updated_at: string
}

export interface WireDocument {
  document_id: string
  ciphertext: string
  ciphertext_hash: string
  revision: number
  deleted: boolean
  updated_at: string
}

export interface SocketMessage {
  type: string
  challenge?: string
  workspace_id?: string
  signature?: string
  document_id?: string
  document_ids?: string[]
  ciphertext?: string
  ciphertext_hash?: string
  base_revision?: number
  deleted?: boolean
  documents?: WireDocument[]
  publications?: Publication[]
  publication?: Publication
  public_id?: string
  title?: string
  content?: string
  content_mode?: ContentMode
  render_mode?: PublicationRenderMode
  kdf_salt?: string
  kdf_memory?: number
  kdf_iterations?: number
  kdf_parallelism?: number
  auth_public_key?: string
  rotation_documents?: Array<{ document_id: string; ciphertext: string; ciphertext_hash: string; revision: number }>
  error?: string
  error_code?: string
}

export interface SessionKeys {
  contentKey: Uint8Array
  authSeed: Uint8Array
  authPublicKey: Uint8Array
}
