// A conversation's code view: its side pane (Explorer, Search or Source Control), its editor
// tabs and what they show, and its quick open. It lasts as long as the conversation's view.

import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { DirEntry, GitChange, GitCommit, GitOp, SearchQuery, SearchResult, Source } from '@shared/code'
import { api } from '../state.svelte'
import { errorMessage } from '../util'
import { dirtyDocs, openDoc, releaseDoc, saveDoc, sourceKey } from './docs.svelte'
import type { Doc, Opened } from './docs.svelte'
import { releaseFolder, useFolder } from './folder.svelte'
import type { Folder } from './folder.svelte'

export type SidePane = 'explorer' | 'search' | 'scm'

export interface EditorTab {
  /** `file:<path>`, or `diff:<side>:<path>` for a change. */
  id: string
  kind: 'file' | 'diff'
  /** The file the tab is about. */
  path: string
  title: string
  /** What a diff compares, as VS Code says it: "Working Tree", "Index", a commit. */
  detail: string
  /** VS Code's preview tab: the next file opened for a look replaces it. */
  preview: boolean
  /** The diff's left side; null for a file, or a change with one version (added, deleted). */
  original: Source | null
  modified: Source
}

/** Where the editor goes once it shows a tab. */
export interface Reveal {
  tabId: string
  line: number
  column: number
  length: number
}

/** A quick open entry that runs something: a command, a branch. */
export interface PickItem {
  label: string
  description?: string
  keys?: string
  run: () => void
}

interface Loaded {
  original: Promise<Opened> | null
  modified: Promise<Opened>
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Every conversation's code view in this window, by conversation id. */
const views = new Map<string, CodeView>()

/**
 * Before a conversation's tab closes: the user saves or drops the unsaved files its code view
 * alone holds. False when they keep the tab.
 */
export function confirmCloseConversation(conversationId: string): Promise<boolean> {
  return views.get(conversationId)?.confirmClose() ?? Promise.resolve(true)
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export class CodeView {
  readonly folder: Folder
  open = $state(false)
  /** The view was opened once, so its components exist. */
  mounted = $state(false)
  side = $state<SidePane>('explorer')
  sideVisible = $state(true)
  tabs = $state<EditorTab[]>([])
  activeId = $state<string | null>(null)
  reveal = $state<Reveal | null>(null)
  /** A diff tab to scroll to its first change once it shows. */
  revealChange = $state<string | null>(null)
  /** Increase to move the keyboard focus there. */
  focusEditor = $state(0)
  focusSearch = $state(0)

  expanded = new SvelteSet<string>()
  children = new SvelteMap<string, DirEntry[]>()
  selected = $state<string | null>(null)
  explorerError = $state<string | null>(null)

  query = $state<SearchQuery>({ pattern: '', matchCase: false, wholeWord: false, regex: false, include: '', exclude: '' })
  searchDetails = $state(false)
  result = $state.raw<SearchResult | null>(null)
  searching = $state(false)
  searchError = $state<string | null>(null)
  collapsedResults = new SvelteSet<string>()

  commitMessage = $state('')
  /** The graph's open commits, each with the files it changed (null while they load). */
  graphOpen = new SvelteMap<string, GitChange[] | null>()
  /** How many commits the graph lists. */
  graphCount = $state(100)
  /** A commit for the graph to show: open, and in sight, once its history reaches it. */
  graphReveal = $state<string | null>(null)
  /** Git commands running, and the last one's error. */
  gitBusy = $state(0)
  gitError = $state<string | null>(null)

  /** Quick open: what is typed, and a list to pick from instead of files. */
  quick = $state<{ text: string; pick: PickItem[] | null; placeholder: string } | null>(null)
  /** Files opened here, the latest first. */
  recent = $state<string[]>([])
  /** The search result opened last: its file, and the match's place among the file's. */
  searchOpened = $state<{ path: string; index: number } | null>(null)

  /**
   * Set by the editor, for a tab that closes: resolves once no editor holds its models, which are
   * then disposed. An editor keeps showing a closed tab until another one shows.
   */
  beforeRelease: ((tabId: string) => Promise<void> | void) | null = null
  private readonly loaded = new Map<string, Loaded>()
  /** Tab ids, the most recently active first. */
  private mru: string[] = []
  private searchSeq = 0
  private readonly stopListening: () => void

  constructor(
    readonly conversationId: string,
    readonly cwd: string,
  ) {
    this.folder = useFolder(cwd)
    this.stopListening = this.folder.onChange((paths) => this.filesChanged(paths))
    views.set(conversationId, this)
  }

  dispose(): void {
    if (views.get(this.conversationId) === this) views.delete(this.conversationId)
    this.stopListening()
    for (const tab of this.tabs) this.release(tab.id)
    releaseFolder(this.folder)
  }

  get activeTab(): EditorTab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  /** The first time, the side pane is Source Control when there are changes to see. */
  show(): void {
    if (!this.mounted && (this.folder.status?.count ?? 0) > 0) this.side = 'scm'
    this.open = true
    this.mounted = true
  }

  /** A side pane from a shortcut: always shown. */
  showSide(pane: SidePane): void {
    this.show()
    this.side = pane
    this.sideVisible = true
    if (pane === 'search') this.focusSearch++
  }

  showQuickOpen(text = ''): void {
    this.show()
    this.quick = { text, pick: null, placeholder: 'Search files by name (append : to go to a line or > for commands)' }
  }

  pick(items: PickItem[], placeholder: string): void {
    this.quick = { text: '', pick: items, placeholder }
  }

  // ---- tabs ----

  openFile(path: string, opts: { preview?: boolean; line?: number; column?: number; length?: number; focus?: boolean } = {}): void {
    this.openTab({ id: `file:${path}`, kind: 'file', path, title: basename(path), detail: '', preview: false, original: null, modified: { kind: 'file', path } }, opts)
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 50)
  }

  /** The tab a change in source control opens, so its row can show when that tab does. */
  changeTabId(change: GitChange, group: 'staged' | 'unstaged' | 'conflicts', root: string): string {
    const path = `${root}/${change.path}`
    if (group === 'conflicts' || change.letter === 'U') return `file:${path}`
    return `diff:${group === 'staged' ? 'index' : 'wt'}:${path}`
  }

  /** The tab a commit's change opens, from the graph or a line's blame. */
  commitTabId(hash: string, change: GitChange, root: string): string {
    return `diff:${hash}:${root}/${change.path}`
  }

  /**
   * A change in source control, as VS Code opens it: its diff; for an added or deleted file the
   * one version there is; for an untracked or conflicted one the file itself.
   */
  openChange(change: GitChange, group: 'staged' | 'unstaged' | 'conflicts', root: string, opts: { preview?: boolean; focus?: boolean } = {}): void {
    const path = `${root}/${change.path}`
    const id = this.changeTabId(change, group, root)
    if (id.startsWith('file:')) {
      this.openFile(path, opts)
      return
    }
    const git = (rev: string, p: string): Source => ({ kind: 'git', root, rev, path: p })
    const staged = group === 'staged'
    // The index against HEAD when staged, the working tree against the index when not.
    const before = staged ? git('HEAD', change.origPath ?? change.path) : git('', change.path)
    const after: Source = staged ? git('', change.path) : { kind: 'file', path }
    this.openTab(
      {
        id,
        kind: 'diff',
        path,
        title: basename(path),
        detail: change.letter === 'D' ? 'Deleted' : staged ? 'Index' : 'Working Tree',
        preview: false,
        original: change.letter === 'A' || change.letter === 'D' ? null : before,
        modified: change.letter === 'D' ? before : after,
      },
      opts,
    )
  }

  /** A file a commit changed, against the commit's first parent; an added or deleted file as its one version. */
  openCommitChange(commit: GitCommit, change: GitChange, root: string, opts: { preview?: boolean; focus?: boolean } = {}): void {
    const path = `${root}/${change.path}`
    const parent = commit.parents[0]
    const before: Source | null = parent ? { kind: 'git', root, rev: parent, path: change.origPath ?? change.path } : null
    const after: Source = { kind: 'git', root, rev: commit.hash, path: change.path }
    this.openTab(
      {
        id: this.commitTabId(commit.hash, change, root),
        kind: 'diff',
        path,
        title: basename(path),
        detail: `${commit.hash.slice(0, 7)}${change.letter === 'D' ? ', Deleted' : ''}`,
        preview: false,
        original: change.letter === 'A' || change.letter === 'D' ? null : before,
        modified: change.letter === 'D' && before ? before : after,
      },
      opts,
    )
  }

  private openTab(tab: EditorTab, opts: { preview?: boolean; line?: number; column?: number; length?: number; focus?: boolean }): void {
    this.show()
    const preview = opts.preview ?? false
    const existing = this.tabs.find((t) => t.id === tab.id)
    if (existing) {
      if (!preview) existing.preview = false
    } else {
      const replaced = preview ? this.tabs.find((t) => t.preview) : undefined
      const at = this.tabs.findIndex((t) => t.id === (replaced ? replaced.id : this.activeId)) + (replaced ? 0 : 1)
      if (replaced) this.drop(replaced.id)
      this.loaded.set(tab.id, { original: tab.original ? openDoc(tab.original) : null, modified: openDoc(tab.modified) })
      this.tabs.splice(Math.min(at, this.tabs.length), 0, { ...tab, preview })
    }
    this.activate(tab.id)
    if (opts.line) this.reveal = { tabId: tab.id, line: opts.line, column: opts.column ?? 1, length: opts.length ?? 0 }
    // A change opened is shown at its first change, also when its tab was open and scrolled away.
    if (tab.kind === 'diff') this.revealChange = tab.id
    if (opts.focus) this.focusEditor++
  }

  activate(id: string): void {
    this.activeId = id
    this.mru = [id, ...this.mru.filter((t) => t !== id)]
    const tab = this.activeTab
    if (tab) this.revealInExplorer(tab.path)
  }

  pin(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (tab) tab.preview = false
  }

  /** What a tab shows: its documents, loading or loaded. */
  content(id: string): Loaded | null {
    return this.loaded.get(id) ?? null
  }

  moveTab(id: string, to: number): void {
    const from = this.tabs.findIndex((t) => t.id === id)
    if (from < 0 || from === to) return
    const [tab] = this.tabs.splice(from, 1)
    if (tab) this.tabs.splice(to, 0, tab)
  }

  /** Documents with unsaved changes that only these tabs hold, which closing them would lose. */
  private async unsavedDocs(ids: string[]): Promise<Doc[]> {
    const held = new Map<string, { doc: Doc; tabs: number }>()
    for (const id of ids) {
      const loaded = this.loaded.get(id)
      for (const pending of [loaded?.original, loaded?.modified]) {
        const opened = await pending?.catch(() => null)
        if (opened?.kind !== 'doc') continue
        const entry = held.get(opened.doc.key) ?? { doc: opened.doc, tabs: 0 }
        entry.tabs++
        held.set(opened.doc.key, entry)
      }
    }
    return [...held.values()].filter((e) => dirtyDocs.has(e.doc.key) && e.tabs >= e.doc.refs).map((e) => e.doc)
  }

  /** Some tab shows a file with unsaved changes; answers at once, for a key that must be stopped now. */
  hasUnsaved(): boolean {
    return this.tabs.some((t) => t.modified.kind === 'file' && dirtyDocs.has(sourceKey(t.modified)))
  }

  /**
   * Asks whether to save unsaved files before they close, as VS Code does: true to go on (after
   * saving them, or not), false to keep them open.
   */
  private async keepOrSave(docs: Doc[]): Promise<boolean> {
    if (docs.length === 0) return true
    const names = docs.map((d) => basename(d.model.uri.path))
    const message = docs.length === 1 ? `Do you want to save the changes you made to ${names[0]}?` : `Do you want to save the changes to the following ${docs.length} files?`
    const detail = `${docs.length > 1 ? `${names.join('\n')}\n\n` : ''}Your changes will be lost if you don't save them.`
    const choice = await api.ask(message, detail, [docs.length === 1 ? 'Save' : 'Save All', "Don't Save", 'Cancel'])
    if (choice === 2) return false
    if (choice === 1) return true
    for (const doc of docs) if (!(await saveDoc(doc))) return false
    return true
  }

  /** Closes a tab; with unsaved changes, the user saves them, drops them or keeps the tab. False when it stays. */
  async closeTab(id: string): Promise<boolean> {
    if (!this.tabs.some((t) => t.id === id)) return true
    const unsaved = await this.unsavedDocs([id])
    if (unsaved.length > 0) this.activate(id)
    if (!(await this.keepOrSave(unsaved))) return false
    this.drop(id)
    return true
  }

  /** Before the conversation's tab closes. */
  async confirmClose(): Promise<boolean> {
    return this.keepOrSave(await this.unsavedDocs(this.tabs.map((t) => t.id)))
  }

  async closeTabs(ids: string[]): Promise<void> {
    for (const id of ids) if (!(await this.closeTab(id))) return
  }

  private drop(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index < 0) return
    this.tabs.splice(index, 1)
    this.mru = this.mru.filter((t) => t !== id)
    if (this.activeId === id) this.activeId = this.mru.find((t) => this.tabs.some((x) => x.id === t)) ?? this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
    this.release(id)
  }

  private release(id: string): void {
    const loaded = this.loaded.get(id)
    if (!loaded) return
    this.loaded.delete(id)
    void Promise.resolve(this.beforeRelease?.(id)).then(() => {
      for (const p of [loaded.original, loaded.modified]) {
        void p?.then(
          (opened) => opened.kind === 'doc' && releaseDoc(opened.doc),
          () => {},
        )
      }
    })
  }

  async save(id: string | null = this.activeId): Promise<void> {
    const loaded = id ? this.loaded.get(id) : null
    if (!loaded || !id) return
    const opened = await loaded.modified
    if (opened.kind === 'doc' && dirtyDocs.has(opened.doc.key) && (await saveDoc(opened.doc))) this.pin(id)
  }

  async saveAll(): Promise<void> {
    for (const tab of this.tabs) await this.save(tab.id)
  }

  // ---- explorer ----

  async loadDir(dir: string): Promise<void> {
    try {
      this.children.set(dir, await api.listDir(this.cwd, dir))
      this.explorerError = null
    } catch (err) {
      // A folder that is gone is no longer shown.
      this.children.delete(dir)
      this.expanded.delete(dir)
      if (dir === this.cwd) this.explorerError = errorMessage(err)
    }
  }

  toggleDir(dir: string): void {
    if (this.expanded.has(dir)) this.expanded.delete(dir)
    else {
      this.expanded.add(dir)
      void this.loadDir(dir)
    }
  }

  collapseAll(): void {
    this.expanded.clear()
  }

  /** VS Code's explorer.autoReveal: the folders down to the active file open, and it is selected. */
  revealInExplorer(path: string): void {
    if (!path.startsWith(`${this.cwd}/`)) return
    this.selected = path
    for (let dir = dirname(path); dir.length > this.cwd.length; dir = dirname(dir)) {
      if (!this.expanded.has(dir)) {
        this.expanded.add(dir)
        if (!this.children.has(dir)) void this.loadDir(dir)
      }
    }
  }

  /** Shows a folder in the explorer, opened, as a link to it does. */
  revealFolder(dir: string): void {
    this.showSide('explorer')
    this.revealInExplorer(dir)
    if (!this.expanded.has(dir)) this.toggleDir(dir)
  }

  private filesChanged(paths: string[] | null): void {
    const dirs = paths === null ? [...this.children.keys()] : [...new Set(paths.filter((p) => !/\/\.git(\/|$)/.test(p)).map(dirname))].filter((d) => this.children.has(d))
    for (const dir of dirs) void this.loadDir(dir)
  }

  // ---- search ----

  async runSearch(): Promise<void> {
    const query = $state.snapshot(this.query)
    const seq = ++this.searchSeq
    if (!query.pattern) {
      this.result = null
      this.searching = false
      this.searchError = null
      return
    }
    this.searching = true
    try {
      const result = await api.search(this.cwd, query)
      if (seq !== this.searchSeq || !result) return
      this.result = result
      this.searchError = null
      this.collapsedResults.clear()
    } catch (err) {
      if (seq !== this.searchSeq) return
      this.result = null
      this.searchError = errorMessage(err)
    } finally {
      if (seq === this.searchSeq) this.searching = false
    }
  }

  // ---- git ----

  /** Runs a git command; a failure shows in Source Control. False when it failed or the user declined. */
  async runGit(op: GitOp): Promise<boolean> {
    this.gitError = null
    this.gitBusy++
    try {
      return await api.git(this.cwd, op)
    } catch (err) {
      this.gitError = errorMessage(err)
      this.showSide('scm')
      return false
    } finally {
      this.gitBusy--
      void this.folder.refresh().catch(() => {})
    }
  }

  async commit(amend = false, push = false): Promise<void> {
    if (await this.runGit({ kind: 'commit', message: this.commitMessage, amend, push })) this.commitMessage = ''
  }

  openCommit(hash: string): void {
    if (this.graphOpen.has(hash)) return
    this.graphOpen.set(hash, null)
    api.commitChanges(this.cwd, hash).then(
      (list) => this.graphOpen.has(hash) && this.graphOpen.set(hash, list),
      (err: unknown) => {
        this.graphOpen.delete(hash)
        this.gitError = errorMessage(err)
      },
    )
  }

  toggleCommit(hash: string): void {
    if (this.graphOpen.has(hash)) this.graphOpen.delete(hash)
    else this.openCommit(hash)
  }

  /** Shows a commit in Source Control's graph, opened to its files, as for a line's blame. */
  revealCommit(hash: string): void {
    this.showSide('scm')
    this.openCommit(hash)
    this.graphReveal = hash
  }

  /** VS Code's "Checkout to…": a branch picked in quick open. */
  async checkout(): Promise<void> {
    try {
      const branches = await api.branches(this.cwd)
      const current = this.folder.status?.branch
      this.show()
      this.pick(
        branches.map((branch) => ({ label: branch, description: branch === current ? 'current' : '', run: () => void this.runGit({ kind: 'checkout', branch }) })),
        'Select a branch to checkout',
      )
    } catch (err) {
      this.gitError = errorMessage(err)
      this.showSide('scm')
    }
  }

  clearSearch(): void {
    this.query.pattern = ''
    void this.runSearch()
  }
}
