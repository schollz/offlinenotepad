import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { insertLink, toggleBold, toggleInlineCode } from './commands'

function testView(doc: string, anchor: number, head = anchor, extensions: Extension[] = []): { view: EditorView, state: () => EditorState } {
  let state = EditorState.create({ doc, selection: EditorSelection.range(anchor, head), extensions })
  const view = {
    get state() { return state },
    dispatch(...specs: TransactionSpec[]) { state = state.update(...specs).state },
  } as unknown as EditorView
  return { view, state: () => state }
}

describe('Markdown formatting commands', () => {
  it('wraps a selection without changing the selected text', () => {
    const editor = testView('make this bold', 5, 9)
    expect(toggleBold(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe('make **this** bold')
    expect(editor.state().sliceDoc(editor.state().selection.main.from, editor.state().selection.main.to)).toBe('this')
  })

  it('inserts paired inline-code markers at an empty cursor', () => {
    const editor = testView('code ', 5)
    expect(toggleInlineCode(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe('code ``')
    expect(editor.state().selection.main.head).toBe(6)
  })

  it('creates a link and selects the URL placeholder', () => {
    const editor = testView('Read this', 5, 9)
    expect(insertLink(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe('Read [this](https://)')
    expect(editor.state().sliceDoc(editor.state().selection.main.from, editor.state().selection.main.to)).toBe('https://')
  })

  it('records formatting edits in CodeMirror history', () => {
    const editor = testView('undo me', 0, 4, [history()])
    toggleBold(editor.view)
    expect(editor.state().doc.toString()).toBe('**undo** me')
    expect(undo(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe('undo me')
  })
})
