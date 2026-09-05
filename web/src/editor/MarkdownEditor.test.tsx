import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor'

afterEach(cleanup)

function sourceText(): string {
  return Array.from(document.querySelectorAll('.cm-line'), (line) => line.textContent ?? '').join('\n')
}

describe('MarkdownEditor', () => {
  it('preserves Markdown exactly across live/source changes and external updates', () => {
    const onChange = vi.fn()
    const initial = '# Heading\n\n__bold__\n\n```ts\nconst x = 1\n```\n'
    const view = render(<MarkdownEditor documentId="note-one" value={initial} mode="source" onChange={onChange} />)
    screen.getByLabelText('Note content')
    expect(sourceText()).toBe(initial)

    view.rerender(<MarkdownEditor documentId="note-one" value={initial} mode="live" onChange={onChange} />)
    view.rerender(<MarkdownEditor documentId="note-one" value={initial} mode="source" onChange={onChange} />)
    expect(sourceText()).toBe(initial)

    const external = `${initial}\nRemote line`
    view.rerender(<MarkdownEditor documentId="note-one" value={external} mode="source" onChange={onChange} />)
    expect(sourceText()).toBe(external)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('destroys the previous editor when changing documents', () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentId="note-one" value="first" mode="source" onChange={onChange} />)
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1)
    view.rerender(<MarkdownEditor documentId="note-two" value="second" mode="source" onChange={onChange} />)
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1)
    expect(screen.getByLabelText('Note content')).toHaveTextContent('second')
  })
})
