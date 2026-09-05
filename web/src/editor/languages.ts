import type { LanguageDescription } from '@codemirror/language'
import { LanguageDescription as Description, LanguageSupport, StreamLanguage } from '@codemirror/language'

export const codeLanguages: readonly LanguageDescription[] = [
  Description.of({
    name: 'JavaScript', alias: ['js', 'jsx', 'node'], extensions: ['js', 'mjs', 'cjs', 'jsx'],
    load: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ jsx: true })),
  }),
  Description.of({
    name: 'TypeScript', alias: ['ts', 'tsx'], extensions: ['ts', 'tsx'],
    load: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ typescript: true, jsx: true })),
  }),
  Description.of({
    name: 'JSON', alias: ['json5'], extensions: ['json', 'json5'],
    load: () => import('@codemirror/lang-json').then(({ json }) => json()),
  }),
  Description.of({
    name: 'HTML', alias: ['htm'], extensions: ['html', 'htm'],
    load: () => import('@codemirror/lang-html').then(({ html }) => html()),
  }),
  Description.of({
    name: 'CSS', extensions: ['css'],
    load: () => import('@codemirror/lang-css').then(({ css }) => css()),
  }),
  Description.of({
    name: 'Go', alias: ['golang'], extensions: ['go'],
    load: () => import('@codemirror/lang-go').then(({ go }) => go()),
  }),
  Description.of({
    name: 'SQL', extensions: ['sql'],
    load: () => import('@codemirror/lang-sql').then(({ sql }) => sql()),
  }),
  Description.of({
    name: 'Shell', alias: ['sh', 'bash', 'zsh'], extensions: ['sh', 'bash', 'zsh'],
    load: () => import('@codemirror/legacy-modes/mode/shell').then(({ shell }) => new LanguageSupport(StreamLanguage.define(shell))),
  }),
  Description.of({
    name: 'Python', alias: ['py'], extensions: ['py'],
    load: () => import('@codemirror/lang-python').then(({ python }) => python()),
  }),
]
