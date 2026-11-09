// File references in agents' text, as Claude Code writes them: `src/foo.ts:42` in inline code, or a
// markdown link whose href is a path relative to the working directory, [foo.ts](src/foo.ts:42).

/** Context key: the conversation's folder and its files, for rich text to link references to them. */
export const FILES = Symbol('files')

export interface FileContext {
  readonly cwd: string
  /** The folder's files, relative to it. */
  files(): Promise<Set<string>>
}

export interface FileRef {
  path: string
  /** 1-based; undefined when the reference names no line. */
  line?: number
  column?: number
}

/** A link's href that names a file rather than a page: no scheme, or `file:`. */
export function isFileHref(href: string): boolean {
  if (!href || href.startsWith('#') || href.startsWith('//')) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]
  if (!scheme) return true
  // A "scheme" with a dot is a file's name before its line: README.md:12.
  return scheme.toLowerCase() === 'file' || scheme.includes('.')
}

const INLINE = /^(?:~?\/|\.\.?\/)?(?:[\w@.+-]+\/)*[\w@.+-]*\.\w+(?::\d+(?:[-:]\d+)?)?$/

/** Inline code that could be a file reference: a path with an extension, maybe a line. */
export function looksLikeFileRef(text: string): boolean {
  return INLINE.test(text)
}

/** `path:line:column`, `path:line-line`, `path#L12C3` or `file://path` → its parts. */
export function parseFileRef(ref: string): FileRef {
  let text = ref
  try {
    text = decodeURI(ref)
  } catch {
    // Not percent-encoded after all.
  }
  text = text.replace(/^file:\/\//, '')
  const hash = /#L(\d+)(?:C(\d+))?(?:-L?\d+)?$/.exec(text)
  if (hash) return { path: text.slice(0, hash.index), line: Number(hash[1]), column: hash[2] ? Number(hash[2]) : undefined }
  const colon = /:(\d+)(?:-\d+|:(\d+))?$/.exec(text)
  if (colon) return { path: text.slice(0, colon.index), line: Number(colon[1]), column: colon[2] ? Number(colon[2]) : undefined }
  return { path: text }
}

/** A path as the agent wrote it, relative to its working directory or absolute, made absolute. */
export function resolvePath(cwd: string, path: string): string {
  const parts = path.startsWith('/') ? [] : cwd.split('/').filter(Boolean)
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
