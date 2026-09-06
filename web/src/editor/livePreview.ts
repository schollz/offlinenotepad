import { syntaxTree } from '@codemirror/language'
import { EditorSelection, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { GFM, parser as markdownParser } from '@lezer/markdown'

interface TablePreview {
  alignments: Array<'left' | 'center' | 'right' | undefined>
  header: string[]
  rows: string[][]
}

const inlineParser = markdownParser.configure(GFM)
const hidden = Decoration.replace({})

function reveal(view: EditorView, from: number, to: number): void {
  view.dispatch({
    selection: EditorSelection.cursor(Math.min(from + 1, to)),
    scrollIntoView: true,
    userEvent: 'select',
  })
  view.focus()
}

function activateWidget(element: HTMLElement, view: EditorView, from: number, to: number): void {
  element.contentEditable = 'false'
  element.tabIndex = 0
  element.addEventListener('click', () => reveal(view, from, to))
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    reveal(view, from, to)
  })
}

class TextWidget extends WidgetType {
  constructor(private readonly text: string, private readonly className: string) { super() }

  eq(other: TextWidget): boolean {
    return this.text === other.text && this.className === other.className
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = this.className
    span.textContent = this.text
    return span
  }
}

class RuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-live-rule'
    span.setAttribute('aria-hidden', 'true')
    return span
  }
}

class TaskWidget extends WidgetType {
  constructor(private readonly from: number, private readonly checked: boolean) { super() }

  eq(other: TaskWidget): boolean {
    return this.from === other.from && this.checked === other.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('input')
    checkbox.className = 'cm-live-task'
    checkbox.type = 'checkbox'
    checkbox.checked = this.checked
    checkbox.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete')
    checkbox.addEventListener('change', () => {
      view.dispatch({
        changes: { from: this.from + 1, to: this.from + 2, insert: checkbox.checked ? 'x' : ' ' },
        userEvent: 'input',
      })
      view.focus()
    })
    return checkbox
  }
}

class CodeLanguageWidget extends WidgetType {
  constructor(private readonly language: string) { super() }

  eq(other: CodeLanguageWidget): boolean {
    return this.language === other.language
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-live-code-language'
    span.textContent = this.language || 'code'
    return span
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly source: string,
    private readonly alt: string,
    private readonly title: string,
  ) { super() }

  eq(other: ImageWidget): boolean {
    return this.from === other.from && this.to === other.to && this.source === other.source
      && this.alt === other.alt && this.title === other.title
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-live-image'
    wrapper.setAttribute('role', 'button')
    wrapper.setAttribute('aria-label', `${this.alt || 'Image'}. Press Enter to edit Markdown source.`)
    activateWidget(wrapper, view, this.from, this.to)

    const safeSource = safeImageSource(this.source)
    if (safeSource) {
      const image = document.createElement('img')
      image.src = safeSource
      image.alt = this.alt
      if (this.title) image.title = this.title
      image.loading = 'lazy'
      image.addEventListener('load', () => view.requestMeasure())
      image.addEventListener('error', () => view.requestMeasure())
      wrapper.append(image)
    } else {
      wrapper.classList.add('blocked')
      const label = document.createElement('span')
      label.textContent = this.alt || 'Remote image blocked'
      const url = document.createElement('small')
      url.textContent = this.source
      wrapper.append(label, url)
    }
    return wrapper
  }
}

class TableWidget extends WidgetType {
  constructor(private readonly from: number, private readonly to: number, private readonly table: TablePreview) { super() }

  eq(other: TableWidget): boolean {
    return this.from === other.from && this.to === other.to
      && JSON.stringify(this.table) === JSON.stringify(other.table)
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-live-table-wrap'
    wrapper.setAttribute('role', 'group')
    wrapper.setAttribute('aria-label', 'Markdown table. Press Enter to edit source.')
    activateWidget(wrapper, view, this.from, this.to)

    const table = document.createElement('table')
    const head = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.table.header.forEach((cell, index) => headRow.append(renderCell('th', cell, this.table.alignments[index])))
    head.append(headRow)
    table.append(head)

    if (this.table.rows.length) {
      const body = document.createElement('tbody')
      for (const row of this.table.rows) {
        const element = document.createElement('tr')
        row.forEach((cell, index) => element.append(renderCell('td', cell, this.table.alignments[index])))
        body.append(element)
      }
      table.append(body)
    }
    wrapper.append(table)
    return wrapper
  }
}

function renderCell(tag: 'th' | 'td', markdown: string, alignment: TablePreview['alignments'][number]): HTMLTableCellElement {
  const cell = document.createElement(tag)
  if (alignment) cell.style.textAlign = alignment
  renderInlineMarkdown(markdown, cell)
  return cell
}

function renderInlineMarkdown(markdown: string, parent: HTMLElement): void {
  const tree = inlineParser.parse(markdown)
  const paragraph = tree.topNode.getChild('Paragraph')
  if (!paragraph) {
    parent.textContent = markdown
    return
  }
  renderInlineChildren(paragraph, markdown, parent)
}

function renderInlineChildren(node: SyntaxNode, source: string, parent: HTMLElement): void {
  let position = node.from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > position) parent.append(document.createTextNode(source.slice(position, child.from)))
    renderInlineNode(child, source, parent)
    position = child.to
  }
  if (position < node.to) parent.append(document.createTextNode(source.slice(position, node.to)))
}

function renderInlineNode(node: SyntaxNode, source: string, parent: HTMLElement): void {
  if (['EmphasisMark', 'StrikethroughMark', 'LinkMark', 'URL', 'LinkLabel', 'LinkTitle', 'CodeMark'].includes(node.name)) return
  if (node.name === 'Escape') {
    parent.append(document.createTextNode(source.slice(node.from + 1, node.to)))
    return
  }
  if (node.name === 'HardBreak') {
    parent.append(document.createElement('br'))
    return
  }
  if (node.name === 'InlineCode') {
    const code = document.createElement('code')
    const raw = source.slice(node.from, node.to)
    const marker = raw.match(/^`+/u)?.[0].length ?? 1
    code.textContent = raw.slice(marker, -marker)
    parent.append(code)
    return
  }
  if (node.name === 'Image') {
    const markers = node.getChildren('LinkMark')
    parent.append(document.createTextNode(markers.length > 1 ? source.slice(markers[0].to, markers[1].from) : 'image'))
    return
  }

  const tags: Record<string, keyof HTMLElementTagNameMap> = {
    StrongEmphasis: 'strong',
    Emphasis: 'em',
    Strikethrough: 'del',
    Link: 'span',
    Autolink: 'span',
  }
  const tag = tags[node.name]
  if (tag) {
    const element = document.createElement(tag)
    if (node.name === 'Link' || node.name === 'Autolink') element.className = 'cm-live-link'
    renderInlineChildren(node, source, element)
    parent.append(element)
    return
  }
  renderInlineChildren(node, source, parent)
}

function normalizeLabel(value: string): string {
  return value.replace(/^\[|\]$/gu, '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

function referenceLinks(state: EditorState): Map<string, string> {
  const links = new Map<string, string>()
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return
      const syntaxNode = node.node
      const label = syntaxNode.getChild('LinkLabel')
      const url = syntaxNode.getChild('URL')
      if (label && url) links.set(normalizeLabel(state.sliceDoc(label.from, label.to)), state.sliceDoc(url.from, url.to))
    },
  })
  return links
}

function selectionTouches(state: EditorState, node: SyntaxNode): boolean {
  return state.selection.ranges.some((range) => range.empty
    ? range.head >= node.from && range.head <= node.to
    : range.from <= node.to && range.to >= node.from)
}

function hideRange(ranges: Range<Decoration>[], from: number, to: number): void {
  if (to > from) ranges.push(hidden.range(from, to))
}

function hideMarkerAndSpace(state: EditorState, ranges: Range<Decoration>[], node: SyntaxNode, widget?: WidgetType): void {
  const line = state.doc.lineAt(node.to)
  let to = node.to
  while (to < line.to && /\s/u.test(state.sliceDoc(to, to + 1))) to++
  ranges.push(Decoration.replace({ widget }).range(node.from, to))
}

function addLineClasses(state: EditorState, ranges: Range<Decoration>[], node: SyntaxNode, className: string): void {
  let line = state.doc.lineAt(node.from)
  const last = state.doc.lineAt(node.to)
  while (line.number <= last.number) {
    ranges.push(Decoration.line({ class: className }).range(line.from))
    if (line.number === last.number) break
    line = state.doc.line(line.number + 1)
  }
}

function addCodeLineClasses(state: EditorState, ranges: Range<Decoration>[], node: SyntaxNode): void {
  let line = state.doc.lineAt(node.from)
  const firstNumber = line.number
  const lastNumber = state.doc.lineAt(node.to).number
  while (line.number <= lastNumber) {
    const edges = `${line.number === firstNumber ? ' cm-live-code-first' : ''}${line.number === lastNumber ? ' cm-live-code-last' : ''}`
    ranges.push(Decoration.line({ class: `cm-live-code-line${edges}` }).range(line.from))
    if (line.number === lastNumber) break
    line = state.doc.line(line.number + 1)
  }
}

function addCodeSpellcheckAttributes(state: EditorState, ranges: Range<Decoration>[], node: SyntaxNode): void {
  let line = state.doc.lineAt(node.from)
  const lastNumber = state.doc.lineAt(node.to).number
  while (line.number <= lastNumber) {
    ranges.push(Decoration.line({ attributes: { spellcheck: 'false' } }).range(line.from))
    if (line.number === lastNumber) break
    line = state.doc.line(line.number + 1)
  }
}

function imageData(state: EditorState, node: SyntaxNode): { source: string, alt: string, title: string } | null {
  const url = node.getChild('URL')
  const markers = node.getChildren('LinkMark')
  if (!url || markers.length < 2) return null
  const title = node.getChild('LinkTitle')
  return {
    source: state.sliceDoc(url.from, url.to),
    alt: state.sliceDoc(markers[0].to, markers[1].from),
    title: title ? state.sliceDoc(title.from + 1, title.to - 1) : '',
  }
}

function parseAlignments(separator: string): TablePreview['alignments'] {
  const trimmed = separator.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  return trimmed.split('|').map((cell) => {
    const value = cell.trim()
    if (value.startsWith(':') && value.endsWith(':')) return 'center'
    if (value.endsWith(':')) return 'right'
    if (value.startsWith(':')) return 'left'
    return undefined
  })
}

function tableData(state: EditorState, node: SyntaxNode): TablePreview | null {
  const headerNode = node.getChild('TableHeader')
  const separator = node.getChild('TableDelimiter')
  if (!headerNode || !separator) return null
  const cells = (row: SyntaxNode) => row.getChildren('TableCell').map((cell) => state.sliceDoc(cell.from, cell.to).trim())
  return {
    alignments: parseAlignments(state.sliceDoc(separator.from, separator.to)),
    header: cells(headerNode),
    rows: node.getChildren('TableRow').map(cells),
  }
}

function linkTarget(state: EditorState, node: SyntaxNode, references: Map<string, string>): string | null {
  const direct = node.getChild('URL')
  if (direct) return state.sliceDoc(direct.from, direct.to)
  const label = node.getChild('LinkLabel')
  return label ? references.get(normalizeLabel(state.sliceDoc(label.from, label.to))) ?? null : null
}

function decorateNode(state: EditorState, node: SyntaxNode, ranges: Range<Decoration>[], references: Map<string, string>): void {
  const active = selectionTouches(state, node)

  if (node.name === 'Table' && !active) {
    const table = tableData(state, node)
    if (table) ranges.push(Decoration.replace({ widget: new TableWidget(node.from, node.to, table), block: true }).range(node.from, node.to))
    return
  }
  if (node.name === 'Image' && !active) {
    const image = imageData(state, node)
    if (image) ranges.push(Decoration.replace({ widget: new ImageWidget(node.from, node.to, image.source, image.alt, image.title) }).range(node.from, node.to))
    return
  }
  if (node.name === 'HorizontalRule' && !active) {
    ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
    return
  }

  if (/^ATXHeading[1-6]$/u.test(node.name)) {
    const level = Number(node.name.at(-1))
    const line = state.doc.lineAt(node.from)
    ranges.push(Decoration.line({
      class: `cm-live-heading cm-live-heading-${level}`,
      attributes: { role: 'heading', 'aria-level': String(level) },
    }).range(line.from))
    if (!active) {
      const prefix = state.sliceDoc(node.from, node.to).match(/^#{1,6}\s*/u)?.[0] ?? ''
      hideRange(ranges, node.from, node.from + prefix.length)
    }
  }

  if (node.name === 'Blockquote') {
    addLineClasses(state, ranges, node, 'cm-live-blockquote')
  }
  if (node.name === 'QuoteMark' && node.parent && !selectionTouches(state, node.parent)) {
    hideMarkerAndSpace(state, ranges, node)
  }

  if (node.name === 'ListMark' && node.parent && !selectionTouches(state, node.parent)) {
    const marker = state.sliceDoc(node.from, node.to)
    const task = node.parent.getChild('Task')
    const label = /^\d/u.test(marker) ? marker : task ? '' : '•'
    hideMarkerAndSpace(state, ranges, node, label ? new TextWidget(label, 'cm-live-list-marker') : undefined)
  }
  if (node.name === 'TaskMarker' && node.parent && !selectionTouches(state, node.parent)) {
    const checked = /x/i.test(state.sliceDoc(node.from, node.to))
    ranges.push(Decoration.replace({ widget: new TaskWidget(node.from, checked) }).range(node.from, node.to))
  }

  if (node.name === 'StrongEmphasis') {
    ranges.push(Decoration.mark({ class: 'cm-live-strong' }).range(node.from, node.to))
  } else if (node.name === 'Emphasis') {
    ranges.push(Decoration.mark({ class: 'cm-live-emphasis' }).range(node.from, node.to))
  } else if (node.name === 'Strikethrough') {
    ranges.push(Decoration.mark({ class: 'cm-live-strike' }).range(node.from, node.to))
  } else if (node.name === 'InlineCode') {
    ranges.push(Decoration.mark({ class: 'cm-live-inline-code' }).range(node.from, node.to))
  }
  if (['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode'].includes(node.name) && !active) {
    for (const marker of [...node.getChildren('EmphasisMark'), ...node.getChildren('StrikethroughMark'), ...node.getChildren('CodeMark')]) {
      hideRange(ranges, marker.from, marker.to)
    }
  }

  if (node.name === 'Link' || node.name === 'Autolink') {
    const markers = node.getChildren('LinkMark')
    const target = linkTarget(state, node, references)
    const labelFrom = markers[0]?.to ?? node.from
    const labelTo = markers[1]?.from ?? node.getChild('URL')?.to ?? node.to
    if (labelTo > labelFrom) ranges.push(Decoration.mark({
      class: 'cm-live-link',
      attributes: target ? { 'data-link-target': target } : undefined,
    }).range(labelFrom, labelTo))
    if (!active) {
      for (const marker of markers) hideRange(ranges, marker.from, marker.to)
      const url = node.getChild('URL')
      const label = node.getChild('LinkLabel')
      if (url && node.name === 'Link') hideRange(ranges, url.from, url.to)
      if (label) hideRange(ranges, label.from, label.to)
    }
  } else if (node.name === 'URL' && node.parent?.name === 'Paragraph') {
    ranges.push(Decoration.mark({ class: 'cm-live-link', attributes: { 'data-link-target': state.sliceDoc(node.from, node.to) } }).range(node.from, node.to))
  }

  if (node.name === 'FencedCode') {
    addCodeLineClasses(state, ranges, node)
    const marks = node.getChildren('CodeMark')
    const info = node.getChild('CodeInfo')
    if (!active && marks.length) {
      const firstLine = state.doc.lineAt(marks[0].from)
      const language = info ? state.sliceDoc(info.from, info.to) : ''
      ranges.push(Decoration.replace({ widget: new CodeLanguageWidget(language) }).range(marks[0].from, firstLine.to))
      const closing = marks.at(-1)
      if (closing && closing !== marks[0]) hideRange(ranges, closing.from, closing.to)
    }
  } else if (node.name === 'CodeBlock') {
    addCodeLineClasses(state, ranges, node)
  } else if (node.name === 'HTMLBlock') {
    addLineClasses(state, ranges, node, 'cm-live-html-source')
  }

  for (let child = node.firstChild; child; child = child.nextSibling) decorateNode(state, child, ranges, references)
}

export function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const references = referenceLinks(state)
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) decorateNode(state, node, ranges, references)
  return Decoration.set(ranges, true)
}

function buildCodeSpellcheckDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        addCodeSpellcheckAttributes(state, ranges, node.node)
      }
    },
  })
  return Decoration.set(ranges, true)
}

const codeSpellcheckField = StateField.define<DecorationSet>({
  create: buildCodeSpellcheckDecorations,
  update(decorations, transaction) {
    return transaction.docChanged ? buildCodeSpellcheckDecorations(transaction.state) : decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

const livePreviewField = StateField.define<DecorationSet>({
  create: buildLivePreviewDecorations,
  update(decorations, transaction) {
    return transaction.docChanged || transaction.selection !== undefined
      ? buildLivePreviewDecorations(transaction.state)
      : decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

export const livePreview: Extension = livePreviewField
export const disableCodeSpellcheck: Extension = codeSpellcheckField

export function safeImageSource(source: string, base = globalThis.location?.href ?? 'http://localhost/'): string | null {
  const value = source.trim().replace(/^<|>$/gu, '')
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/iu.test(value)) return value
  try {
    const target = new URL(value, base)
    const current = new URL(base)
    return ['http:', 'https:'].includes(target.protocol) && target.origin === current.origin ? target.href : null
  } catch {
    return null
  }
}

export function safeLinkTarget(source: string, base = globalThis.location?.href ?? 'http://localhost/'): string | null {
  try {
    const target = new URL(source.trim().replace(/^<|>$/gu, ''), base)
    return ['http:', 'https:', 'mailto:'].includes(target.protocol) ? target.href : null
  } catch {
    return null
  }
}

export const openLiveLink: Extension = EditorView.domEventHandlers({
  click(event) {
    if (!(event.metaKey || event.ctrlKey) || !(event.target instanceof Element)) return false
    const target = event.target.closest<HTMLElement>('[data-link-target]')?.dataset.linkTarget
    const safeTarget = target ? safeLinkTarget(target) : null
    if (!safeTarget) return false
    event.preventDefault()
    window.open(safeTarget, '_blank', 'noopener,noreferrer')
    return true
  },
})
