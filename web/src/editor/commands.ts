import { EditorSelection } from '@codemirror/state'
import type { Command } from '@codemirror/view'

function wrapSelection(open: string, close = open): Command {
  return (view) => {
    const transaction = view.state.changeByRange((range) => {
      if (range.empty) {
        return {
          changes: { from: range.from, insert: open + close },
          range: EditorSelection.cursor(range.from + open.length),
        }
      }

      const selected = view.state.sliceDoc(range.from, range.to)
      return {
        changes: { from: range.from, to: range.to, insert: open + selected + close },
        range: EditorSelection.range(range.from + open.length, range.to + open.length),
      }
    })
    view.dispatch(transaction, { scrollIntoView: true, userEvent: 'input' })
    return true
  }
}

export const toggleBold = wrapSelection('**')
export const toggleItalic = wrapSelection('*')
export const toggleStrikethrough = wrapSelection('~~')
export const toggleInlineCode = wrapSelection('`')

export const insertLink: Command = (view) => {
  const transaction = view.state.changeByRange((range) => {
    const label = view.state.sliceDoc(range.from, range.to)
    const replacement = `[${label}](https://)`
    const urlFrom = range.from + label.length + 3
    return {
      changes: { from: range.from, to: range.to, insert: replacement },
      range: label
        ? EditorSelection.range(urlFrom, urlFrom + 'https://'.length)
        : EditorSelection.cursor(range.from + 1),
    }
  })
  view.dispatch(transaction, { scrollIntoView: true, userEvent: 'input' })
  return true
}

