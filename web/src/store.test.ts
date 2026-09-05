import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('Markdown editor preference', () => {
  it('defaults to live preview and persists source mode on this device', async () => {
    const first = await import('./store')
    expect(first.useUI.getState().markdownEditorMode).toBe('live')
    first.useUI.getState().setMarkdownEditorMode('source')
    expect(localStorage.getItem('offlinenotepad-markdown-editor-mode')).toBe('source')

    vi.resetModules()
    const reloaded = await import('./store')
    expect(reloaded.useUI.getState().markdownEditorMode).toBe('source')
  })

  it('ignores an invalid stored editor mode', async () => {
    localStorage.setItem('offlinenotepad-markdown-editor-mode', 'preview')
    const store = await import('./store')
    expect(store.useUI.getState().markdownEditorMode).toBe('live')
  })
})

