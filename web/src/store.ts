import { create } from 'zustand'

type Theme = 'system' | 'light' | 'dark'
export type MarkdownEditorMode = 'live' | 'source'

interface UIState {
  sidebarOpen: boolean
  theme: Theme
  markdownEditorMode: MarkdownEditorMode
  toast: string
  setSidebarOpen: (value: boolean) => void
  setTheme: (value: Theme) => void
  setMarkdownEditorMode: (value: MarkdownEditorMode) => void
  showToast: (value: string) => void
}

const savedTheme = (localStorage.getItem('offlinenotepad-theme') as Theme | null) ?? 'system'
const savedMarkdownEditorMode: MarkdownEditorMode = localStorage.getItem('offlinenotepad-markdown-editor-mode') === 'source' ? 'source' : 'live'

export const useUI = create<UIState>((set) => ({
  sidebarOpen: false,
  theme: savedTheme,
  markdownEditorMode: savedMarkdownEditorMode,
  toast: '',
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setTheme: (theme) => {
    localStorage.setItem('offlinenotepad-theme', theme)
    set({ theme })
  },
  setMarkdownEditorMode: (markdownEditorMode) => {
    localStorage.setItem('offlinenotepad-markdown-editor-mode', markdownEditorMode)
    set({ markdownEditorMode })
  },
  showToast: (toast) => {
    set({ toast })
    window.setTimeout(() => set((state) => (state.toast === toast ? { toast: '' } : state)), 3600)
  },
}))
