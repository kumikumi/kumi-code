// Markdown as the agent writes it: GitHub-flavoured, rendered to HTML and
// sanitized (the text is model output), code blocks highlighted with Shiki.

import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import type { Highlighter } from 'shiki'

const THEME = 'github-dark-default'

const marked = new Marked({ gfm: true, renderer: { code: ({ text, lang }) => codeBlockHtml(text, lang ?? '') } })

export function markdownHtml(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }))
}

/** A code block: a bar with the language and a copy button, then the code. */
export function codeBlockHtml(code: string, lang: string): string {
  return `<div class="codeblock"><div class="codeblock-bar"><span>${escape(lang)}</span><button class="ghost small" data-copy>Copy</button></div><pre data-lang="${escape(lang)}">${escape(code)}</pre></div>`
}

/** Clicks in rendered HTML: copy buttons, and links, which open in the browser. */
export function onRichClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  const copy = target.closest('[data-copy]')
  if (copy) void navigator.clipboard.writeText(copy.closest('.codeblock')?.querySelector('pre')?.textContent ?? '')
  const link = target.closest('a')
  if (link) {
    e.preventDefault()
    window.open(link.href)
  }
}

/** Replaces the code blocks under `root` with highlighted ones, for languages Shiki knows. */
export function highlightBlocks(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>('pre[data-lang]')) {
    const code = pre.textContent ?? ''
    void highlight(code, pre.dataset.lang ?? '').then(
      (html) => {
        // Shiki escapes the code; the HTML is its own markup.
        if (html && pre.isConnected) pre.outerHTML = html
      },
      (err: unknown) => console.error('Highlighting failed', err),
    )
  }
}

let highlighter: Promise<Highlighter> | null = null
const cache = new Map<string, string>()

async function highlight(code: string, lang: string): Promise<string | null> {
  const { bundledLanguages, bundledLanguagesAlias, createHighlighter, createJavaScriptRegexEngine } = await import('shiki')
  if (!(lang in bundledLanguages || lang in bundledLanguagesAlias)) return null
  const key = `${lang}\n${code}`
  const cached = cache.get(key)
  if (cached) return cached
  highlighter ??= createHighlighter({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() })
  const h = await highlighter
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
  const html = h.codeToHtml(code, { lang, theme: THEME })
  if (cache.size > 200) cache.clear()
  cache.set(key, html)
  return html
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
