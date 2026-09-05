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

describe('Desktop sidebar preference', () => {
  it('defaults to expanded and restores a collapsed sidebar on this device', async () => {
    const first = await import('./store')
    expect(first.useUI.getState().sidebarCollapsed).toBe(false)
    first.useUI.getState().setSidebarCollapsed(true)
    expect(localStorage.getItem('offlinenotepad-sidebar-collapsed')).toBe('true')

    vi.resetModules()
    const reloaded = await import('./store')
    expect(reloaded.useUI.getState().sidebarCollapsed).toBe(true)
  })

  it('treats an invalid stored value as expanded', async () => {
    localStorage.setItem('offlinenotepad-sidebar-collapsed', 'collapsed')
    const store = await import('./store')
    expect(store.useUI.getState().sidebarCollapsed).toBe(false)
  })
})
