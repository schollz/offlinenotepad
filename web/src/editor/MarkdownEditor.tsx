import { useLayoutEffect, useRef, type MouseEvent } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightSpecialChars, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import { insertLink, toggleBold, toggleInlineCode, toggleItalic, toggleStrikethrough } from './commands'
import { codeLanguages } from './languages'
import { disableCodeSpellcheck, livePreview, openLiveLink } from './livePreview'

export type MarkdownEditorMode = 'live' | 'source'

interface MarkdownEditorProps {
  documentId: string
  value: string
  mode: MarkdownEditorMode
  onChange: (markdown: string) => void
}

const externalUpdate = Annotation.define<boolean>()
const scrollbarMeasureKey = {}

function updateScrollbarVisibility(view: EditorView): void {
  view.requestMeasure({
    key: scrollbarMeasureKey,
    read: (measuredView) => {
      const lastBlock = measuredView.lineBlockAt(measuredView.state.doc.length)
      return measuredView.documentPadding.top + lastBlock.bottom > measuredView.scrollDOM.clientHeight + 1
    },
    write: (overflows, measuredView) => {
      measuredView.scrollDOM.dataset.contentOverflow = overflows ? 'true' : 'false'
    },
  })
}

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--text)', fontWeight: '500' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--blue)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--blue)' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
  { tag: tags.keyword, color: 'var(--syntax-purple)' },
  { tag: [tags.string, tags.regexp, tags.escape, tags.special(tags.string)], color: 'var(--syntax-green)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syntax-orange)' },
  { tag: [tags.comment, tags.meta], color: '#7f8a9a', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--syntax-yellow)' },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName, tags.labelName, tags.macroName], color: 'var(--syntax-blue)' },
  { tag: [tags.operator, tags.punctuation], color: '#abb2bf' },
])

const formattingKeymap = Prec.highest(keymap.of([
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-Shift-x', run: toggleStrikethrough },
  { key: 'Mod-e', run: toggleInlineCode },
  { key: 'Mod-k', run: insertLink },
]))

export function MarkdownEditor({ documentId, value, mode, onChange }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const modeCompartment = useRef(new Compartment())
  const valueRef = useRef(value)
  const modeRef = useRef(mode)
  const onChangeRef = useRef(onChange)
  valueRef.current = value
  modeRef.current = mode
  onChangeRef.current = onChange

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const viewMode = modeCompartment.current
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        EditorState.phrases.of({ 'Selection deleted': '' }),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Note content',
          'aria-multiline': 'true',
          autocapitalize: 'sentences',
          spellcheck: 'true',
        }),
        placeholderExtension('Start writing in Markdown…'),
        markdown({
          base: commonmarkLanguage,
          extensions: [GFM],
          codeLanguages: (info) => /^(?:md|markdown)$/iu.test(info)
            ? commonmarkLanguage
            : LanguageDescription.matchLanguageName(codeLanguages, info),
        }),
        syntaxHighlighting(markdownHighlightStyle),
        disableCodeSpellcheck,
        formattingKeymap,
        openLiveLink,
        viewMode.of(modeRef.current === 'live' ? livePreview : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.geometryChanged) updateScrollbarVisibility(update.view)
          if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(externalUpdate))) return
          onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    updateScrollbarVisibility(view)
    viewRef.current = view
    return () => {
      if (viewRef.current === view) viewRef.current = null
      view.destroy()
    }
  }, [documentId])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    const selection = view.state.selection.main
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: {
        anchor: Math.min(selection.anchor, value.length),
        head: Math.min(selection.head, value.length),
      },
      annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)],
    })
  }, [documentId, value])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: modeCompartment.current.reconfigure(mode === 'live' ? livePreview : []) })
  }, [documentId, mode])

  function focusAtEndFromEmptySpace(event: MouseEvent<HTMLDivElement>): void {
    const view = viewRef.current
    if (!view || event.button !== 0) return
    const lastLine = view.contentDOM.querySelector<HTMLElement>(':scope > .cm-line:last-of-type')
    const editorBounds = view.dom.getBoundingClientRect()
    const scrollBounds = view.scrollDOM.getBoundingClientRect()
    const target = event.target
    if (!lastLine
      || (target instanceof Element && target.closest('.cm-panels'))
      || event.clientY <= lastLine.getBoundingClientRect().bottom
      || event.clientY > editorBounds.bottom
      || event.clientX < editorBounds.left
      || event.clientX > editorBounds.right
      || (event.clientY <= scrollBounds.bottom
        && (event.clientX > scrollBounds.left + view.scrollDOM.clientWidth
          || event.clientY > scrollBounds.top + view.scrollDOM.clientHeight))) return

    event.preventDefault()
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true })
    view.focus()
  }

  return <div ref={hostRef} className="markdown-editor" data-document-id={documentId} data-mode={mode} onMouseDownCapture={focusAtEndFromEmptySpace} />
}
