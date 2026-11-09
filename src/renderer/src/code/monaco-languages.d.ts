// Monaco's language definitions ship without declarations; the code view uses their settings only.
declare module 'monaco-editor/languages/definitions/*' {
  import type { languages } from 'monaco-editor'
  export const conf: languages.LanguageConfiguration
}
