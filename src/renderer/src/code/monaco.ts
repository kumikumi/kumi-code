// Monaco, loaded when a code view first opens. It runs without language services (types,
// IntelliSense, diagnostics): files open as text, highlighted with Shiki's TextMate grammars
// in VS Code's Dark+ colors, as VS Code highlights them. Comments, brackets and indentation
// rules come from Monaco's own language definitions.

import type * as Monaco from 'monaco-editor'
import type { Highlighter } from 'shiki'

export type MonacoApi = typeof import('monaco-editor/editor/editor.api.js')

/** VS Code's default dark theme's token colors. */
const SHIKI_THEME = 'dark-plus'
export const EDITOR_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/** File extensions → Shiki's language ids. */
const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'jsonl', css: 'css', scss: 'scss', sass: 'sass', less: 'less', html: 'html', htm: 'html',
  svelte: 'svelte', vue: 'vue', astro: 'astro', md: 'markdown', markdown: 'markdown', mdx: 'mdx', py: 'python', pyi: 'python',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp',
  hpp: 'cpp', hh: 'cpp', m: 'objective-c', mm: 'objective-cpp', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'shellscript',
  bash: 'shellscript', zsh: 'shellscript', fish: 'fish', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', svg: 'xml', plist: 'xml',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir', scala: 'scala', tf: 'hcl',
  hcl: 'hcl', proto: 'proto', prisma: 'prisma', r: 'r', pl: 'perl', ps1: 'powershell', zig: 'zig', nix: 'nix', hs: 'haskell',
  ml: 'ocaml', clj: 'clojure', erl: 'erlang', jl: 'julia', diff: 'diff', patch: 'diff', ini: 'ini', cfg: 'ini', properties: 'properties',
  csv: 'csv', log: 'log', vb: 'vb', glsl: 'glsl', wgsl: 'wgsl', cmake: 'cmake', mk: 'make', gradle: 'groovy', groovy: 'groovy', tex: 'latex',
}
/** Files known by their whole name. */
const NAMES: Record<string, string> = {
  Dockerfile: 'docker', Makefile: 'make', makefile: 'make', 'CMakeLists.txt': 'cmake', Gemfile: 'ruby', Rakefile: 'ruby',
  '.zshrc': 'shellscript', '.bashrc': 'shellscript', '.zprofile': 'shellscript', '.profile': 'shellscript', '.env': 'dotenv',
  '.gitignore': 'shellscript', '.npmrc': 'ini', '.editorconfig': 'ini', 'tsconfig.json': 'jsonc', 'jsconfig.json': 'jsonc',
}
/** Monaco's language definitions, for their comment, bracket and indentation settings. */
const DEFINITIONS: Record<string, () => Promise<{ conf: Monaco.languages.LanguageConfiguration }>> = {
  typescript: () => import('monaco-editor/languages/definitions/typescript/typescript.js'),
  javascript: () => import('monaco-editor/languages/definitions/javascript/javascript.js'),
  css: () => import('monaco-editor/languages/definitions/css/css.js'),
  scss: () => import('monaco-editor/languages/definitions/scss/scss.js'),
  less: () => import('monaco-editor/languages/definitions/less/less.js'),
  html: () => import('monaco-editor/languages/definitions/html/html.js'),
  markdown: () => import('monaco-editor/languages/definitions/markdown/markdown.js'),
  python: () => import('monaco-editor/languages/definitions/python/python.js'),
  go: () => import('monaco-editor/languages/definitions/go/go.js'),
  rust: () => import('monaco-editor/languages/definitions/rust/rust.js'),
  java: () => import('monaco-editor/languages/definitions/java/java.js'),
  kotlin: () => import('monaco-editor/languages/definitions/kotlin/kotlin.js'),
  swift: () => import('monaco-editor/languages/definitions/swift/swift.js'),
  cpp: () => import('monaco-editor/languages/definitions/cpp/cpp.js'),
  csharp: () => import('monaco-editor/languages/definitions/csharp/csharp.js'),
  ruby: () => import('monaco-editor/languages/definitions/ruby/ruby.js'),
  php: () => import('monaco-editor/languages/definitions/php/php.js'),
  shell: () => import('monaco-editor/languages/definitions/shell/shell.js'),
  yaml: () => import('monaco-editor/languages/definitions/yaml/yaml.js'),
  xml: () => import('monaco-editor/languages/definitions/xml/xml.js'),
  sql: () => import('monaco-editor/languages/definitions/sql/sql.js'),
  dockerfile: () => import('monaco-editor/languages/definitions/dockerfile/dockerfile.js'),
  ini: () => import('monaco-editor/languages/definitions/ini/ini.js'),
  lua: () => import('monaco-editor/languages/definitions/lua/lua.js'),
  dart: () => import('monaco-editor/languages/definitions/dart/dart.js'),
  elixir: () => import('monaco-editor/languages/definitions/elixir/elixir.js'),
  scala: () => import('monaco-editor/languages/definitions/scala/scala.js'),
  graphql: () => import('monaco-editor/languages/definitions/graphql/graphql.js'),
  hcl: () => import('monaco-editor/languages/definitions/hcl/hcl.js'),
  perl: () => import('monaco-editor/languages/definitions/perl/perl.js'),
  r: () => import('monaco-editor/languages/definitions/r/r.js'),
  powershell: () => import('monaco-editor/languages/definitions/powershell/powershell.js'),
  clojure: () => import('monaco-editor/languages/definitions/clojure/clojure.js'),
  julia: () => import('monaco-editor/languages/definitions/julia/julia.js'),
  protobuf: () => import('monaco-editor/languages/definitions/protobuf/protobuf.js'),
}
/** Shiki's language ids → the Monaco definition whose settings fit them. */
const DEFINITION_OF: Record<string, string> = {
  typescript: 'typescript', tsx: 'typescript', javascript: 'javascript', jsx: 'javascript', css: 'css', scss: 'scss', sass: 'scss',
  less: 'less', html: 'html', svelte: 'html', vue: 'html', astro: 'html', markdown: 'markdown', mdx: 'markdown', python: 'python',
  go: 'go', rust: 'rust', java: 'java', kotlin: 'kotlin', swift: 'swift', c: 'cpp', cpp: 'cpp', 'objective-c': 'cpp', 'objective-cpp': 'cpp',
  csharp: 'csharp', ruby: 'ruby', php: 'php', shellscript: 'shell', fish: 'shell', dotenv: 'shell', yaml: 'yaml', xml: 'xml', sql: 'sql',
  docker: 'dockerfile', ini: 'ini', toml: 'ini', properties: 'ini', lua: 'lua', dart: 'dart', elixir: 'elixir', scala: 'scala',
  graphql: 'graphql', hcl: 'hcl', perl: 'perl', r: 'r', powershell: 'powershell', clojure: 'clojure', julia: 'julia', proto: 'protobuf',
  groovy: 'java', make: 'shell', cmake: 'shell',
}
const JSON_CONF: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
}

let loading: Promise<MonacoApi> | null = null
let highlighter: Highlighter | null = null
/** Shiki's colors by index, as its tokens refer to them. */
let colorMap: string[] = []
const languages = new Map<string, Promise<void>>()
const themes = new Set<string>()

/** Monaco, set up; the first call loads it. */
export function loadMonaco(): Promise<MonacoApi> {
  loading ??= load()
  return loading
}

async function load(): Promise<MonacoApi> {
  const [monaco, , { default: EditorWorker }, shiki] = await Promise.all([
    import('monaco-editor/editor/editor.api.js'),
    import('monaco-editor/features/register.all.js'),
    import('monaco-editor/editor/editor.worker.js?worker'),
    import('shiki'),
  ])
  // The editor worker computes diffs and word suggestions off the main thread.
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  // Forgiving: a grammar pattern the JavaScript engine cannot run is skipped rather than failing the language.
  highlighter = await shiki.createHighlighter({ themes: [SHIKI_THEME], langs: [], engine: shiki.createJavaScriptRegexEngine({ forgiving: true }) })
  colorMap = highlighter.setTheme(SHIKI_THEME).colorMap
  return monaco
}

/** The language a file opens in: Shiki's id, or plaintext. */
export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const byName = NAMES[name]
  if (byName) return byName
  const dot = name.lastIndexOf('.')
  return (dot > 0 && EXTENSIONS[name.slice(dot + 1).toLowerCase()]) || 'plaintext'
}

/** Registers a language with Monaco, highlighted by Shiki's grammar for it. */
export function ensureLanguage(monaco: MonacoApi, lang: string): Promise<void> {
  if (lang === 'plaintext') return Promise.resolve()
  let ready = languages.get(lang)
  if (!ready) {
    ready = (async () => {
      const h = highlighter
      if (!h) throw new Error('Monaco is not loaded')
      await h.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
      monaco.languages.register({ id: lang })
      monaco.languages.setTokensProvider(lang, tokensProvider(h, lang))
      const definition = DEFINITION_OF[lang]
      const conf = definition ? (await DEFINITIONS[definition]?.())?.conf : lang.startsWith('json') ? JSON_CONF : undefined
      if (conf) monaco.languages.setLanguageConfiguration(lang, conf)
    })()
    languages.set(lang, ready)
  }
  return ready
}

type RuleStack = Parameters<ReturnType<Highlighter['getLanguage']>['tokenizeLine2']>[1]

class LineState implements Monaco.languages.IState {
  constructor(readonly stack: RuleStack) {}
  clone(): LineState {
    return this
  }
  equals(other: Monaco.languages.IState): boolean {
    if (!(other instanceof LineState)) return false
    return this.stack === other.stack || (this.stack !== null && other.stack !== null && this.stack.equals(other.stack))
  }
}

/** Longer lines are not highlighted, as in VS Code (`editor.maxTokenizationLineLength`). */
const MAX_LINE = 20_000

/**
 * Monaco tokens named after Shiki's colors: `t<color index>.<font style bits>`. The theme
 * gives each name its color, so highlighting needs no mapping back to TextMate scopes.
 */
function tokensProvider(h: Highlighter, lang: string): Monaco.languages.TokensProvider {
  const grammar = h.getLanguage(lang)
  return {
    getInitialState: () => new LineState(null),
    tokenize(line, state) {
      const stack = (state as LineState).stack
      if (line.length > MAX_LINE) return { tokens: [{ startIndex: 0, scopes: '' }], endState: state }
      const result = grammar.tokenizeLine2(line, stack, 500)
      const tokens: Monaco.languages.IToken[] = []
      for (let i = 0; i < result.tokens.length; i += 2) {
        const meta = result.tokens[i + 1] ?? 0
        // vscode-textmate's encoded token metadata: font style in bits 11-14, foreground in 15-23.
        const style = (meta & 0x7800) >>> 11
        const color = (meta & 0xff8000) >>> 15
        tokens.push({ startIndex: result.tokens[i] ?? 0, scopes: style ? `t${color}.${style}` : `t${color}` })
      }
      return { tokens, endState: new LineState(result.ruleStack) }
    },
  }
}

function fontStyle(bits: number): string {
  return [bits & 1 && 'italic', bits & 2 && 'bold', bits & 4 && 'underline', bits & 8 && 'strikethrough'].filter(Boolean).join(' ')
}

/** Monaco's theme for a conversation theme: Dark+'s token colors on the theme's surfaces, read from `el`'s CSS variables. */
export function applyTheme(monaco: MonacoApi, el: HTMLElement, themeId: string): void {
  const name = `kumi-${themeId}`
  if (!themes.has(name)) {
    themes.add(name)
    const style = getComputedStyle(el)
    const v = (n: string): string => style.getPropertyValue(`--${n}`).trim()
    const hex = (c: string): string => c.replace('#', '').slice(0, 6)
    const rules: Monaco.editor.ITokenThemeRule[] = [{ token: '', foreground: hex(colorMap[1] ?? '#d4d4d4') }]
    colorMap.forEach((color, i) => {
      if (i === 0 || !color) return
      for (let bits = 0; bits < 16; bits++) rules.push({ token: bits ? `t${i}.${bits}` : `t${i}`, foreground: hex(color), fontStyle: fontStyle(bits) })
    })
    monaco.editor.defineTheme(name, {
      base: 'vs-dark',
      inherit: true,
      rules,
      colors: {
        'editor.background': v('bg'),
        'editor.foreground': colorMap[1] ?? '#d4d4d4',
        'editorGutter.background': v('bg'),
        'editorLineNumber.foreground': v('faint'),
        'editorLineNumber.activeForeground': v('text'),
        'editor.lineHighlightBackground': '#00000000',
        'editor.lineHighlightBorder': v('bg-raised'),
        'editorIndentGuide.background1': v('border'),
        'editorIndentGuide.activeBackground1': v('faint'),
        'editorWhitespace.foreground': v('border'),
        'editorOverviewRuler.border': v('bg'),
        'editorStickyScroll.background': v('bg'),
        'editorStickyScrollHover.background': v('bg-hover'),
        'editorWidget.background': v('bg-raised'),
        'editorWidget.border': v('border'),
        'editorHoverWidget.background': v('bg-raised'),
        'editorHoverWidget.border': v('border'),
        'editorSuggestWidget.background': v('bg-raised'),
        'editorSuggestWidget.border': v('border'),
        'editorSuggestWidget.selectedBackground': v('bg-active'),
        'input.background': v('bg-input'),
        'input.border': v('border'),
        focusBorder: v('accent'),
        'quickInput.background': v('bg-raised'),
        'quickInputList.focusBackground': v('bg-active'),
        'list.activeSelectionBackground': v('bg-active'),
        'list.hoverBackground': v('bg-hover'),
        'menu.background': v('bg-raised'),
        'menu.foreground': v('text'),
        'menu.selectionBackground': v('bg-active'),
        'menu.separatorBackground': v('border'),
        'menu.border': v('border'),
        'diffEditor.border': v('border'),
      },
    })
  }
  monaco.editor.setTheme(name)
}
