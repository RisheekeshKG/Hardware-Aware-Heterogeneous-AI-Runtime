import { syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { EditorView } from '@uiw/react-codemirror'

// The code editor's look comes from the design tokens: the editor chrome here, and
// syntax colours in styles/components/editor.css through classHighlighter's tok-* classes.
export const editorTheme = [
  EditorView.theme({
    '&': { color: 'var(--text-primary)', backgroundColor: 'transparent' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--editor-selection)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-sunken)', color: 'var(--text-disabled)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
    '.cm-activeLine': { backgroundColor: 'var(--accent-wash)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--accent-wash)', color: 'var(--text-secondary)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-bg)', outline: '1px solid var(--accent-border)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--accent-bg)' },
    '.cm-tooltip': { border: '1px solid var(--border-strong)', backgroundColor: 'var(--bg-input)', color: 'var(--text-body)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-bg)', color: 'var(--accent)' },
    '.cm-panels': { backgroundColor: 'var(--bg-panel)', color: 'var(--text-body)' },
  }, { dark: true }),
  syntaxHighlighting(classHighlighter),
]
