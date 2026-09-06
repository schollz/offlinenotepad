import type { LanguageDescription } from '@codemirror/language'
import { LanguageDescription as Description, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { shell } from '@codemirror/legacy-modes/mode/shell'

export const codeLanguages: readonly LanguageDescription[] = [
  Description.of({
    name: 'JavaScript', alias: ['js', 'jsx', 'node'], extensions: ['js', 'mjs', 'cjs', 'jsx'],
    support: javascript({ jsx: true }),
  }),
  Description.of({
    name: 'TypeScript', alias: ['ts', 'tsx'], extensions: ['ts', 'tsx'],
    support: javascript({ typescript: true, jsx: true }),
  }),
  Description.of({
    name: 'JSON', alias: ['json5'], extensions: ['json', 'json5'],
    support: json(),
  }),
  Description.of({
    name: 'HTML', alias: ['htm'], extensions: ['html', 'htm'],
    support: html(),
  }),
  Description.of({
    name: 'CSS', extensions: ['css'],
    support: css(),
  }),
  Description.of({
    name: 'Go', alias: ['golang'], extensions: ['go'],
    support: go(),
  }),
  Description.of({
    name: 'SQL', extensions: ['sql'],
    support: sql(),
  }),
  Description.of({
    name: 'Shell', alias: ['sh', 'bash', 'zsh'], extensions: ['sh', 'bash', 'zsh'],
    support: new LanguageSupport(StreamLanguage.define(shell)),
  }),
  Description.of({
    name: 'Python', alias: ['py'], extensions: ['py'],
    support: python(),
  }),
]
