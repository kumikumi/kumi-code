// A conversation's folder as this window sees it: its repository's status (which the code
// toggle's badge counts) and its file changes, watched while a conversation in it is open.

import type { GitStatus } from '@shared/code'
import { api } from '../state.svelte'
import { foldersChanged } from './docs.svelte'

export class Folder {
  /** undefined until known; null outside a repository. */
  status = $state.raw<GitStatus | null | undefined>(undefined)
  refs = 0
  private readonly listeners = new Set<(paths: string[] | null) => void>()
  private files: Promise<string[]> | null = null
  private heard = false

  constructor(readonly cwd: string) {
    api.watchFolder(cwd, true)
    void api.gitStatus(cwd).then(
      (status) => {
        if (!this.heard) this.status = status
      },
      (err: unknown) => console.error(`git status in ${cwd} failed`, err),
    )
  }

  /** Every file of the folder for quick open; listed again after files change. */
  fileList(): Promise<string[]> {
    this.files ??= api.listFiles(this.cwd).catch((err: unknown) => {
      this.files = null
      throw err
    })
    return this.files
  }

  /** Calls `cb` with the paths that change (null: any may have). */
  onChange(cb: (paths: string[] | null) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  changed(paths: string[] | null, status: GitStatus | null): void {
    this.heard = true
    this.status = status
    if (paths === null || paths.some((p) => !p.includes('/.git/'))) this.files = null
    for (const cb of this.listeners) cb(paths)
  }

  /** Reads the status again now, as after a git command. */
  async refresh(): Promise<void> {
    this.status = await api.gitStatus(this.cwd)
  }
}

const folders = new Map<string, Folder>()

/** The folder's state for one more user, which gives it back with `releaseFolder`. */
export function useFolder(cwd: string): Folder {
  let folder = folders.get(cwd)
  if (!folder) {
    folder = new Folder(cwd)
    folders.set(cwd, folder)
  }
  folder.refs++
  return folder
}

export function releaseFolder(folder: Folder): void {
  if (--folder.refs > 0) return
  folders.delete(folder.cwd)
  api.watchFolder(folder.cwd, false)
}

api.onFolderChanged((cwd, paths, status) => {
  folders.get(cwd)?.changed(paths, status)
  void foldersChanged(paths, status)
})
