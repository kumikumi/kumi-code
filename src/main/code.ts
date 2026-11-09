// The code view's main-process side: each watched folder's files and repository, and what the
// view asks of them. A folder is watched while a window shows a conversation in it; its
// changes, and the repository's status after them, go to those windows.

import { BrowserWindow, dialog, Menu, shell, webContents } from 'electron'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { contentOf, listDir, listFiles, readFileContent, searchFiles } from '../core/files'
import * as repo from '../core/repo'
import type { Blame, DirEntry, FileContent, GitChange, GitCommit, GitOp, GitStatus, MenuItem, SearchQuery, SearchResult, Source } from '@shared/code'
import { IPC } from '@shared/types'

/** Changes wait this long for more before the windows hear of them, in milliseconds… */
const SETTLE = 250
/** …but no longer than this after the first. */
const MAX_DELAY = 1000
/** More changed paths than this go out as "everything". */
const MAX_PATHS = 1000

/** One watched folder: its file system watchers, and the changes not yet sent. */
class Folder {
  /** How many of each renderer's views (by web contents id) watch it. */
  readonly views = new Map<number, number>()
  private watchers: FSWatcher[] = []
  /** The folders watched recursively: the repository's (or the folder itself) and its git folder. */
  private watched: string[] = []
  private paths = new Set<string>()
  private all = false
  private timer: NodeJS.Timeout | null = null
  private firstAt = 0
  private running = false
  private again = false

  constructor(
    readonly cwd: string,
    private readonly send: (paths: string[] | null, status: GitStatus | null) => void,
  ) {}

  start(): void {
    void this.refresh()
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.watched = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Something changed: the windows hear of it once changes settle. */
  changed(path: string | null): void {
    if (path === null) this.all = true
    else this.paths.add(path)
    this.schedule()
  }

  /** The repository changed, as after a git command: its status goes out without waiting for the watcher to notice. */
  nudge(): void {
    this.schedule()
  }

  private schedule(): void {
    const now = Date.now()
    if (!this.timer) this.firstAt = now
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), Math.max(0, Math.min(SETTLE, this.firstAt + MAX_DELAY - now)))
  }

  async refresh(): Promise<void> {
    this.timer = null
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    const paths = this.all || this.paths.size > MAX_PATHS ? null : [...this.paths]
    this.paths = new Set()
    this.all = false
    try {
      const info = await repo.repoInfo(this.cwd)
      this.watchTargets(info)
      const status = info ? await repo.status(info.root) : null
      this.send(paths, status)
    } catch (err) {
      console.error(`Reading ${this.cwd} failed`, err)
      this.send(paths, null)
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        void this.refresh()
      }
    }
  }

  /** Watches the repository's top folder (the folder itself outside one) and a git folder that is not inside it. */
  private watchTargets(info: repo.RepoInfo | null): void {
    const top = info?.root ?? this.cwd
    const targets = info && !inside(info.gitDir, top) ? [top, info.gitDir] : [top]
    if (targets.join('\0') === this.watched.join('\0')) return
    for (const w of this.watchers) w.close()
    this.watched = targets
    this.watchers = targets.flatMap((target) => {
      try {
        const w = watch(target, { recursive: true }, (_event, name) => {
          const path = name ? join(target, name.toString()) : null
          if (path === null || !info || !noise(path, info.gitDir)) this.changed(path)
        })
        w.on('error', (err) => console.error(`Watching ${target} failed`, err))
        return [w]
      } catch (err) {
        console.error(`Watching ${target} failed`, err)
        return []
      }
    })
  }
}

/** Git's own bookkeeping, which changes along with the refs and index that matter. */
function noise(path: string, gitDir: string): boolean {
  if (!inside(path, gitDir)) return false
  const rel = relative(gitDir, path)
  return rel.startsWith(`objects${sep}`) || rel.startsWith(`logs${sep}`) || rel.endsWith('.lock')
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))
}

export class Code {
  private readonly folders = new Map<string, Folder>()
  /** Each window's running search per folder: `<contents id>\0<folder>` → cancel. */
  private readonly searches = new Map<string, () => void>()

  watchFolder(contentsId: number, cwd: string, watching: boolean): void {
    let folder = this.folders.get(cwd)
    if (!folder) {
      if (!watching) return
      const created = new Folder(cwd, (paths, status) => this.sendChange(created, paths, status))
      folder = created
      this.folders.set(cwd, folder)
      folder.start()
    }
    const count = (folder.views.get(contentsId) ?? 0) + (watching ? 1 : -1)
    if (count > 0) folder.views.set(contentsId, count)
    else folder.views.delete(contentsId)
    if (folder.views.size === 0) {
      folder.stop()
      this.folders.delete(cwd)
    }
  }

  /** A window closed: it watches nothing and searches nothing any more. */
  forget(contentsId: number): void {
    for (const folder of [...this.folders.values()]) {
      if (!folder.views.has(contentsId)) continue
      folder.views.set(contentsId, 1)
      this.watchFolder(contentsId, folder.cwd, false)
    }
    for (const [key, cancel] of this.searches) {
      if (key.startsWith(`${contentsId}\0`)) {
        cancel()
        this.searches.delete(key)
      }
    }
  }

  private sendChange(folder: Folder, paths: string[] | null, status: GitStatus | null): void {
    for (const id of folder.views.keys()) {
      const contents = webContents.fromId(id)
      if (contents && !contents.isDestroyed()) contents.send(IPC.evFolderChanged, folder.cwd, paths, status)
    }
  }

  /** Sends the status of the folders in the repository after a git command. */
  private touched(root: string): void {
    for (const folder of this.folders.values()) if (inside(folder.cwd, root) || inside(root, folder.cwd)) folder.nudge()
  }

  async gitStatus(cwd: string): Promise<GitStatus | null> {
    const info = await repo.repoInfo(cwd)
    return info ? repo.status(info.root) : null
  }

  async listDir(cwd: string, dir: string): Promise<DirEntry[]> {
    return listDir(dir, (await repo.repoInfo(cwd))?.root ?? null)
  }

  async readSource(source: Source): Promise<FileContent> {
    if (source.kind === 'file') return readFileContent(source.path)
    const bytes = await repo.fileAt(source.root, source.rev, source.path)
    return bytes ? contentOf(bytes, source.path) : { kind: 'missing' }
  }

  async writeFile(path: string, text: string): Promise<void> {
    await writeFile(path, text)
  }

  /** A new file or folder; a name with slashes makes the folders on the way. */
  async createFile(path: string, dir: boolean): Promise<void> {
    if (await exists(path)) throw new Error(`${basename(path)} already exists`)
    if (dir) await mkdir(path, { recursive: true })
    else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '', { flag: 'wx' })
    }
  }

  async renamePath(from: string, to: string): Promise<void> {
    if (from === to) return
    // A change of case alone is the same path on macOS's file system, so it exists.
    if (from.toLowerCase() !== to.toLowerCase() && (await exists(to))) throw new Error(`${basename(to)} already exists`)
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
  }

  async trashPath(win: BrowserWindow, path: string): Promise<boolean> {
    const folder = (await stat(path)).isDirectory()
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `Are you sure you want to delete '${basename(path)}'${folder ? ' and its contents' : ''}?`,
      detail: `You can restore this ${folder ? 'folder' : 'file'} from the Trash.`,
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return false
    await shell.trashItem(path)
    return true
  }

  revealPath(path: string): void {
    shell.showItemInFolder(path)
  }

  listFiles(cwd: string): Promise<string[]> {
    return listFiles(cwd)
  }

  search(contentsId: number, cwd: string, query: SearchQuery): Promise<SearchResult | null> {
    const key = `${contentsId}\0${cwd}`
    this.searches.get(key)?.()
    const { result, cancel } = searchFiles(cwd, query)
    this.searches.set(key, cancel)
    return result.finally(() => {
      if (this.searches.get(key) === cancel) this.searches.delete(key)
    })
  }

  async git(win: BrowserWindow, cwd: string, op: GitOp): Promise<boolean> {
    if (op.kind === 'init') {
      await repo.init(cwd)
      this.touched(cwd)
      return true
    }
    const info = await repo.repoInfo(cwd)
    if (!info) throw new Error(`${cwd} is not in a git repository`)
    const { root } = info
    try {
      const s = await repo.status(root)
      switch (op.kind) {
        case 'stage':
          await repo.stage(root, op.changes)
          return true
        case 'unstage':
          await repo.unstage(root, op.changes, s.head !== null)
          return true
        case 'discard':
          return await this.discard(win, root, op.changes)
        case 'commit':
          return await this.commit(win, root, s, op.message, op.amend, op.push)
        case 'push':
          await repo.push(root, s)
          return true
        case 'pull':
          await repo.pull(root, s)
          return true
        case 'fetch':
          await repo.fetch(root)
          return true
        case 'checkout':
          await repo.checkout(root, op.branch)
          return true
      }
    } finally {
      this.touched(root)
    }
  }

  /** VS Code's discard: tracked files go back to the index, untracked ones to the Trash, once the user agrees. */
  private async discard(win: BrowserWindow, root: string, changes: GitChange[]): Promise<boolean> {
    const untracked = changes.filter((c) => c.letter === 'U')
    const tracked = changes.filter((c) => c.letter !== 'U')
    const name = (c: GitChange): string => basename(c.path)
    const message =
      changes.length === 1 && changes[0]
        ? untracked.length
          ? `Are you sure you want to delete '${name(changes[0])}'?`
          : `Are you sure you want to discard changes in '${name(changes[0])}'?`
        : untracked.length === 0
          ? `Are you sure you want to discard ALL changes in ${changes.length} files?`
          : tracked.length === 0
            ? `Are you sure you want to delete ${untracked.length} untracked files?`
            : `Are you sure you want to discard ALL changes in ${tracked.length} files and delete ${untracked.length} untracked files?`
    const detail = `${tracked.length ? 'Discarded changes cannot be recovered.' : ''}${tracked.length && untracked.length ? ' ' : ''}${untracked.length ? `Untracked files move to the Trash.` : ''}`
    const button = untracked.length && !tracked.length ? 'Move to Trash' : changes.length === 1 ? 'Discard File' : `Discard ${changes.length} Files`
    const { response } = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons: [button, 'Cancel'], defaultId: 0, cancelId: 1 })
    if (response !== 0) return false
    await repo.discardTracked(root, tracked)
    for (const c of untracked) await shell.trashItem(join(root, c.path))
    return true
  }

  /** With nothing staged, VS Code offers to stage everything and commit it. */
  private async commit(win: BrowserWindow, root: string, s: GitStatus, message: string, amend: boolean, push: boolean): Promise<boolean> {
    if (!message.trim() && !amend) throw new Error('Write a commit message first')
    if (s.conflicts.length > 0) throw new Error('Resolve the merge conflicts before committing')
    if (s.staged.length === 0 && !amend) {
      if (s.unstaged.length === 0) throw new Error('There are no changes to commit')
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        message: 'There are no staged changes to commit.',
        detail: 'Would you like to stage all your changes and commit them directly?',
        buttons: ['Stage All and Commit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response !== 0) return false
      await repo.stageAll(root)
    }
    await repo.commit(root, message, amend)
    if (push) await repo.push(root, await repo.status(root))
    return true
  }

  async gitLog(cwd: string, count: number): Promise<GitCommit[]> {
    const info = await repo.repoInfo(cwd)
    return info ? repo.log(info.root, await repo.status(info.root), count) : []
  }

  async commitChanges(cwd: string, hash: string): Promise<GitChange[]> {
    const info = await repo.repoInfo(cwd)
    if (!info) throw new Error(`${cwd} is not in a git repository`)
    return repo.commitChanges(info.root, hash)
  }

  async branches(cwd: string): Promise<string[]> {
    const info = await repo.repoInfo(cwd)
    return info ? repo.localBranches(info.root) : []
  }

  blame(root: string, path: string, text: string | null, rev: string | null): Promise<Blame | null> {
    return repo.blame(root, path, text, rev)
  }

  commitMessage(root: string, hash: string): Promise<string> {
    return repo.commitMessage(root, hash)
  }

  destroy(): void {
    for (const folder of this.folders.values()) folder.stop()
    this.folders.clear()
    for (const cancel of this.searches.values()) cancel()
    this.searches.clear()
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

export function showMenu(win: BrowserWindow, items: MenuItem[]): Promise<string | null> {
  return new Promise((done) => {
    const menu = Menu.buildFromTemplate(
      items.map((item) =>
        item.separator
          ? { type: 'separator' as const }
          : { label: item.label, accelerator: item.accelerator, registerAccelerator: false, enabled: item.enabled ?? true, click: () => done(item.id) },
      ),
    )
    // The menu closes before its item's click handler runs on some platforms.
    menu.popup({ window: win, callback: () => setTimeout(() => done(null), 50) })
  })
}

export async function ask(win: BrowserWindow, message: string, detail: string, buttons: string[]): Promise<number> {
  const { response } = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 })
  return response
}
