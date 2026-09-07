import type { PrivateRecord, WorkspacePreferences } from '../types'

export const workspacePreferencesDocumentID = 'workspace-preferences-v1'

export function isWorkspacePreferences(record: PrivateRecord): record is WorkspacePreferences {
  return 'record_type' in record
    && record.record_type === 'workspace_preferences'
    && record.id === workspacePreferencesDocumentID
    && typeof record.last_opened_note_id === 'string'
    && typeof record.updated_at === 'string'
}
