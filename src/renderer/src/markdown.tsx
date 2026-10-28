// Markdown as the agent writes it: GitHub-flavoured, rendered to React elements
// (no HTML injection from the text), code blocks highlighted with Shiki.

import { memo, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Highlighter } from 'shiki'

const THEME = 'github-dark-default'

let highlighter: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= (async () => {
    const { createHighlighter, createJavaScriptRegexEngine } = await import('shiki')
    return createHighlighter({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() })
  })()
  return highlighter
}

/** Highlighted HTML for a code block, or null when the language is unknown. */
async function highlight(code: string, lang: string): Promise<string | null> {
  const { bundledLanguages, bundledLanguagesAlias } = await import('shiki')
  const known = lang in bundledLanguages || lang in bundledLanguagesAlias
  if (!known) return null
  const h = await getHighlighter()
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
  return h.codeToHtml(code, { lang, theme: THEME })
}

export function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!lang) return
    void highlight(code, lang).then(
      (result) => {
        if (live) setHtml(result)
      },
      (err: unknown) => console.error('Highlighting failed', err),
    )
    return () => {
      live = false
    }
  }, [code, lang])
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang}</span>
        <button className="ghost small" onClick={() => void navigator.clipboard.writeText(code)}>
          Copy
        </button>
      </div>
      {/* Shiki escapes the code; the HTML is its own markup. */}
      {html ? <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} /> : <pre>{code}</pre>}
    </div>
  )
}

const components: Components = {
  code({ className, children }) {
    const lang = /language-(\S+)/.exec(className ?? '')?.[1]
    const text = String(children)
    if (lang === undefined && !text.includes('\n')) return <code className="inline">{children}</code>
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang ?? ''} />
  },
  pre({ children }) {
    return <>{children}</>
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
