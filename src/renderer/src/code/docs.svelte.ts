// The editor's documents: one Monaco model per file, or file at a revision, shared by every
// tab of the window that shows it. A file's document follows the file on disk while it has no
// unsaved changes; a revision's (the index's, HEAD's) follows the repository.

import { diffLines } from 'diff'
import type * as Monaco from 'monaco-editor'
import { SvelteSet } from 'svelte/reactivity'
import type { FileContent, GitStatus, Source } from '@shared/code'
import { api } from '../state.svelte'
import { ensureLanguage, languageOf, loadMonaco } from './monaco'
import type { MonacoApi } from './monaco'

export interface Doc {
  key: string
  source: Source
  model: Monaco.editor.ITextModel
  refs: number
  /** The model's alternative version id when it last matched the file. */
  savedVersion: number
  /** The file's text when last read or written, to tell a change on disk from the user's. */
  diskText: string
}

/** What a tab shows of a source: a document, or why there is none. */
export type Opened = { kind: 'doc'; doc: Doc } | Exclude<FileContent, { kind: 'text' }>

/** Keys of documents with unsaved changes. */
export const dirtyDocs = new SvelteSet<string>()
/** Keys of file documents whose file is gone from disk. */
export const deletedDocs = new SvelteSet<string>()

const docs = new Map<string, Doc>()
/** Set once the first document is made, which loads Monaco. */
let loaded: MonacoApi | null = null
const opening = new Map<string, Promise<Opened>>()

export function sourceKey(s: Source): string {
  return s.kind === 'file' ? `file:${s.path}` : `git:${s.rev || 'index'}:${s.root}/${s.path}`
}

function sourcePath(s: Source): string {
  return s.kind === 'file' ? s.path : `${s.root}/${s.path}`
}

/** Opens a source for a tab, which releases it with `releaseDoc` when it closes. A revision without the file is empty. */
export async function openDoc(source: Source): Promise<Opened> {
  const key = sourceKey(source)
  const existing = docs.get(key)
  if (existing) {
    existing.refs++
    return { kind: 'doc', doc: existing }
  }
  let pending = opening.get(key)
  if (!pending) {
    pending = create(key, source).finally(() => opening.delete(key))
    opening.set(key, pending)
  }
  const opened = await pending
  if (opened.kind === 'doc') opened.doc.refs++
  return opened
}

async function create(key: string, source: Source): Promise<Opened> {
  const [monaco, content] = await Promise.all([loadMonaco(), api.readSource(source)])
  loaded = monaco
  const text = content.kind === 'text' ? content.text : content.kind === 'missing' && source.kind !== 'file' ? '' : null
  if (text === null) return content as Exclude<FileContent, { kind: 'text' }>
  const lang = languageOf(sourcePath(source))
  await ensureLanguage(monaco, lang)
  const uri = source.kind === 'file' ? monaco.Uri.file(source.path) : monaco.Uri.from({ scheme: 'git', path: sourcePath(source), query: source.rev || 'index' })
  const model = monaco.editor.createModel(text, lang, uri)
  const doc: Doc = { key, source, model, refs: 0, savedVersion: model.getAlternativeVersionId(), diskText: text }
  model.onDidChangeContent(() => {
    if (model.getAlternativeVersionId() === doc.savedVersion) dirtyDocs.delete(key)
    else dirtyDocs.add(key)
  })
  docs.set(key, doc)
  return { kind: 'doc', doc }
}

/** A tab let go of the document; the last one disposes it. */
export function releaseDoc(doc: Doc): void {
  if (--doc.refs > 0) return
  docs.delete(doc.key)
  dirtyDocs.delete(doc.key)
  deletedDocs.delete(doc.key)
  doc.model.dispose()
}

/**
 * Writes a file's document to disk. When the file changed on disk since it was read, the user
 * picks: overwrite it, or keep editing. False when nothing was written.
 */
export async function saveDoc(doc: Doc): Promise<boolean> {
  if (doc.source.kind !== 'file') return false
  const path = doc.source.path
  const text = doc.model.getValue()
  const disk = await api.readSource(doc.source)
  if (disk.kind === 'text' && disk.text !== doc.diskText && disk.text !== text) {
    const choice = await api.ask(`The file '${path.slice(path.lastIndexOf('/') + 1)}' changed on disk.`, 'Saving overwrites those changes with yours.', ['Overwrite', 'Cancel'])
    if (choice !== 0) return false
  }
  await api.writeFile(path, text)
  doc.diskText = text
  doc.savedVersion = doc.model.getAlternativeVersionId()
  dirtyDocs.delete(doc.key)
  deletedDocs.delete(doc.key)
  return true
}

/**
 * Files changed on disk (null: any may have), and the repository is in `status`: documents
 * without unsaved changes take the files' new text, and the index's and HEAD's revisions are
 * read again.
 */
export async function foldersChanged(paths: string[] | null, status: GitStatus | null): Promise<void> {
  const reads: Promise<void>[] = []
  for (const doc of docs.values()) {
    const s = doc.source
    if (s.kind === 'file' && (paths === null || paths.some((p) => s.path === p || s.path.startsWith(`${p}/`)))) reads.push(reloadFile(doc))
    else if (s.kind === 'git' && status && s.root === status.root && (s.rev === '' || s.rev === 'HEAD')) reads.push(reloadRevision(doc))
  }
  await Promise.all(reads)
}

async function reloadFile(doc: Doc): Promise<void> {
  const content = await api.readSource(doc.source)
  if (doc.model.isDisposed()) return
  if (content.kind === 'missing') {
    deletedDocs.add(doc.key)
    return
  }
  deletedDocs.delete(doc.key)
  if (content.kind !== 'text' || content.text === doc.diskText) return
  doc.diskText = content.text
  // Unsaved changes stay; saving then asks before overwriting the file.
  if (dirtyDocs.has(doc.key)) return
  replaceText(doc.model, content.text)
  doc.savedVersion = doc.model.getAlternativeVersionId()
  dirtyDocs.delete(doc.key)
}

async function reloadRevision(doc: Doc): Promise<void> {
  const content = await api.readSource(doc.source)
  const text = content.kind === 'text' ? content.text : content.kind === 'missing' ? '' : null
  if (text === null || doc.model.isDisposed() || text === doc.model.getValue()) return
  doc.diskText = text
  replaceText(doc.model, text)
  doc.savedVersion = doc.model.getAlternativeVersionId()
}

/**
 * Changes the model's text to `text` with edits to the lines that differ, so cursors, folds and
 * the scroll position stay where they were, and the change can be undone.
 */
function replaceText(model: Monaco.editor.ITextModel, text: string): void {
  const old = model.getValue()
  if (old === text) return
  const monaco = loaded
  const parts = diffLines(old, text, { maxEditLength: 20_000 })
  if (!monaco || !parts) {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
    return
  }
  const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = []
  let line = 1
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const count = part.count ?? 0
    if (!part.added && !part.removed) {
      line += count
      continue
    }
    // A removal and the addition after it are one replacement.
    const removed = part.removed ? count : 0
    const next = part.removed ? parts[i + 1] : undefined
    const added = part.added ? part.value : next?.added ? next.value : ''
    if (next?.added) i++
    edits.push({ range: new monaco.Range(line, 1, line + removed, 1), text: added })
    line += removed
  }
  model.pushEditOperations([], edits, () => null)
}
