import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, type Range } from '@codemirror/state'
import { Decoration, type EditorView } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { buildLivePreviewDecorations, safeImageSource, safeLinkTarget } from './livePreview'

function state(doc: string, cursor = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: commonmarkLanguage, extensions: [GFM] })],
  })
}

function ranges(document: EditorState): Range<Decoration>[] {
  const found: Range<Decoration>[] = []
  buildLivePreviewDecorations(document).between(0, document.doc.length, (from, to, value) => {
    found.push(value.range(from, to))
  })
  return found
}

describe('live Markdown decorations', () => {
  it('hides inline delimiters away from the cursor and reveals the active construct', () => {
    const source = 'plain **bold** text'
    const inactive = ranges(state(source))
      .filter((range) => range.to > range.from && range.value.spec.widget == null)
      .map((range) => source.slice(range.from, range.to))
    expect(inactive).toEqual(expect.arrayContaining(['**', '**']))

    const active = ranges(state(source, source.indexOf('bold') + 1))
      .filter((range) => range.to > range.from && range.value.spec.widget == null)
      .map((range) => source.slice(range.from, range.to))
    expect(active).not.toContain('**')
  })

  it('replaces inactive tables and images with safe widgets', () => {
    const source = 'intro\n\n| A | B |\n|---|:--:|\n| **x** | y |\n\n![alt](/icon.svg)'
    const decorated = ranges(state(source))
    const table = decorated.find((range) => range.value.spec.block === true)
    expect(source.slice(table?.from, table?.to)).toContain('| A | B |')
    expect(table?.value.spec.widget.constructor.name).toBe('TableWidget')
    const tableDOM = table?.value.spec.widget.toDOM({} as EditorView) as HTMLElement
    expect(tableDOM.querySelector('th')?.textContent).toBe('A')
    expect(tableDOM.querySelectorAll('td')[0]?.querySelector('strong')?.textContent).toBe('x')
    expect(tableDOM.querySelectorAll('th')[1]?.style.textAlign).toBe('center')
    const image = decorated.find((range) => range.value.spec.widget?.constructor.name === 'ImageWidget')
    expect(source.slice(image?.from, image?.to)).toBe('![alt](/icon.svg)')
  })

  it('shows a language badge only while a fenced block is inactive', () => {
    const source = 'intro\n\n```ts\nconst answer = 42\n```'
    const inactive = ranges(state(source))
    expect(inactive.some((range) => range.value.spec.widget?.constructor.name === 'CodeLanguageWidget')).toBe(true)
    const active = ranges(state(source, source.indexOf('answer')))
    expect(active.some((range) => range.value.spec.widget?.constructor.name === 'CodeLanguageWidget')).toBe(false)
  })
})

describe('preview URL policy', () => {
  it('allows only same-origin and safe raster data images', () => {
    expect(safeImageSource('/image.png', 'https://notes.test/app')).toBe('https://notes.test/image.png')
    expect(safeImageSource('https://elsewhere.test/private.png', 'https://notes.test/app')).toBeNull()
    expect(safeImageSource('data:image/png;base64,AAAA', 'https://notes.test/app')).toBe('data:image/png;base64,AAAA')
    expect(safeImageSource('data:image/svg+xml,<svg/>', 'https://notes.test/app')).toBeNull()
  })

  it('rejects executable links while allowing explicit web and mail links', () => {
    expect(safeLinkTarget('javascript:alert(1)', 'https://notes.test/app')).toBeNull()
    expect(safeLinkTarget('/local', 'https://notes.test/app')).toBe('https://notes.test/local')
    expect(safeLinkTarget('mailto:person@example.com', 'https://notes.test/app')).toBe('mailto:person@example.com')
  })
})
