// A project's files, as the code view lists, reads, finds and searches them. Searching
// runs ripgrep, as VS Code does: the Claude Code binary bundled with the SDK is ripgrep
// when started under that name.

import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import type { DirEntry, FileContent, SearchFile, SearchQuery, SearchResult } from '@shared/code'
import { bundledClaudeBinary } from './auth'
import { ignoredPaths } from './repo'

/** VS Code's default `files.exclude`: never listed. */
const HIDDEN = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db'])
/** Ripgrep's globs for `files.exclude` and VS Code's default `search.exclude`. */
const EXCLUDES = [...[...HIDDEN].map((name) => `**/${name}`), '**/node_modules', '**/bower_components', '**/*.code-search'].map((g) => `!${g}`)
/** Larger files open as a notice: the editor slows down well before. */
const MAX_SIZE = 20 * 1024 * 1024
const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}
const MAX_FILES = 200_000
const MAX_MATCHES = 10_000
/** How much of a matched line a result carries: before the match, and in all. */
const PREVIEW_BEFORE = 60
const PREVIEW_LENGTH = 300

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** A folder's entries, folders first, marked when git ignores them. root: the repository's, null outside one. */
export async function listDir(dir: string, root: string | null): Promise<DirEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents
      .filter((d) => !HIDDEN.has(d.name))
      .map(async (d): Promise<DirEntry> => {
        const path = join(dir, d.name)
        const isDir = d.isSymbolicLink() ? await stat(path).then((s) => s.isDirectory(), () => false) : d.isDirectory()
        return { name: d.name, path, dir: isDir, ignored: false }
      }),
  )
  if (root) {
    // A trailing slash lets folder-only patterns (`dist/`) match.
    const rel = new Map(entries.map((e) => [relative(root, e.path).split(sep).join('/') + (e.dir ? '/' : ''), e]))
    for (const key of rel.keys()) if (key.startsWith('../')) rel.delete(key)
    for (const path of await ignoredPaths(root, [...rel.keys()])) {
      const entry = rel.get(path)
      if (entry) entry.ignored = true
    }
  }
  return entries.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
}

export async function readFileContent(path: string): Promise<FileContent> {
  const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  })
  if (!info) return { kind: 'missing' }
  if (info.isDirectory()) throw new Error(`${path} is a folder`)
  if (info.size > MAX_SIZE) return { kind: 'tooLarge', size: info.size }
  return contentOf(await readFile(path), path)
}

/** Bytes as the editor shows them: an image, text, or neither. */
export function contentOf(bytes: Buffer, path: string): FileContent {
  if (bytes.length > MAX_SIZE) return { kind: 'tooLarge', size: bytes.length }
  const mediaType = IMAGES[extname(path).toLowerCase()]
  if (mediaType) return { kind: 'image', mediaType, data: bytes.toString('base64'), size: bytes.length }
  // Git's own test for binary content.
  if (bytes.subarray(0, 8000).includes(0)) return { kind: 'binary', size: bytes.length }
  return { kind: 'text', text: bytes.toString('utf8') }
}

function ripgrep(cwd: string, args: string[]): ReturnType<typeof spawn> {
  return spawn(bundledClaudeBinary(), ['--no-config', '--hidden', '--follow', ...EXCLUDES.flatMap((g) => ['-g', g]), ...args], { cwd, argv0: 'rg' })
}

/** Every file of the folder, relative to it, as VS Code's quick open lists them: hidden files in, ignored files out. */
export function listFiles(cwd: string): Promise<string[]> {
  return new Promise((done, fail) => {
    const child = ripgrep(cwd, ['--files'])
    const files: string[] = []
    let rest = ''
    let errors = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) if (line && files.length < MAX_FILES) files.push(line)
      if (files.length >= MAX_FILES) child.kill()
    })
    child.stderr?.on('data', (d: Buffer) => (errors += d.toString()))
    child.on('error', fail)
    child.on('close', (code) => {
      if (rest && files.length < MAX_FILES) files.push(rest)
      // 1: no files; 2 with files listed: some could not be read.
      if (code === 2 && files.length === 0) fail(new Error(errors.trim() || 'Listing the files failed'))
      else done(files)
    })
  })
}

/** VS Code's include and exclude fields → ripgrep globs: a plain name matches a file or folder anywhere. */
export function searchGlobs(patterns: string, exclude: boolean): string[] {
  return patterns
    .split(',')
    .map((p) => p.trim().replace(/^\.\//, ''))
    .filter(Boolean)
    .flatMap((p) => {
      const globs = /[*?[{]/.test(p) ? [p] : p.includes('/') ? [p, `${p.replace(/\/$/, '')}/**`] : [`**/${p}`, `**/${p}/**`]
      return globs.map((g) => (exclude ? `!${g}` : g))
    })
}

interface RgMatch {
  type: 'match'
  data: { path: { text?: string }; lines: { text?: string }; line_number: number; submatches: { start: number; end: number }[] }
}

/** Searches the folder's files' contents. Calling `cancel` kills ripgrep and resolves with null. */
export function searchFiles(cwd: string, query: SearchQuery): { result: Promise<SearchResult | null>; cancel: () => void } {
  const args = [
    '--json',
    query.matchCase ? '--case-sensitive' : '--ignore-case',
    ...(query.wholeWord ? ['--word-regexp'] : []),
    ...(query.regex ? ['--engine=auto'] : ['--fixed-strings']),
    ...searchGlobs(query.include, false).flatMap((g) => ['-g', g]),
    ...searchGlobs(query.exclude, true).flatMap((g) => ['-g', g]),
    '-e',
    query.pattern,
    '--',
    '.',
  ]
  const child = ripgrep(cwd, args)
  let cancelled = false
  const result = new Promise<SearchResult | null>((done, fail) => {
    const byPath = new Map<string, SearchFile>()
    let matchCount = 0
    let limitHit = false
    let rest = ''
    let errors = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (limitHit) return
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('{"type":"match"')) continue
        const { data } = JSON.parse(line) as RgMatch
        const path = data.path.text?.replace(/^\.\//, '')
        const text = data.lines.text?.replace(/\r?\n$/, '')
        if (path === undefined || text === undefined) continue
        let file = byPath.get(path)
        if (!file) byPath.set(path, (file = { path, matches: [] }))
        for (const m of data.submatches) {
          const start = charOffset(text, m.start)
          const length = charOffset(text, m.end) - start
          const from = Math.max(0, start - PREVIEW_BEFORE)
          file.matches.push({ line: data.line_number, column: start + 1, length, preview: text.slice(from, from + Math.max(PREVIEW_LENGTH, start - from + length)), start: start - from })
          if (++matchCount >= MAX_MATCHES) {
            limitHit = true
            child.kill()
            break
          }
        }
        if (limitHit) break
      }
    })
    child.stderr?.on('data', (d: Buffer) => (errors += d.toString()))
    child.on('error', fail)
    child.on('close', (code) => {
      if (cancelled) done(null)
      // 2 with matches: some files could not be read; without, the pattern is bad.
      else if (code === 2 && matchCount === 0) fail(new Error(errors.trim().replace(/^rg: /, '') || 'The search failed'))
      else done({ files: [...byPath.values()], matchCount, limitHit })
    })
  })
  return {
    result,
    cancel: () => {
      cancelled = true
      child.kill()
    },
  }
}

/** Ripgrep reports byte offsets into the UTF-8 line; the editor counts UTF-16 units. */
function charOffset(text: string, bytes: number): number {
  if (text.length === Buffer.byteLength(text)) return bytes
  return Buffer.from(text).subarray(0, bytes).toString('utf8').length
}
