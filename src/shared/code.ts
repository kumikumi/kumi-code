// What the code view (files, search, source control) passes over IPC. Paths are absolute
// unless they say otherwise; repository-relative paths use "/".

/**
 * The letter a change shows, as VS Code's git extension gives it. U: untracked.
 * !: a merge conflict (both sides changed, added or deleted it).
 */
export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!'

export interface GitChange {
  /** Repository-relative. */
  path: string
  /** Where a renamed or copied file came from, repository-relative; null otherwise. */
  origPath: string | null
  letter: GitLetter
}

/** A folder's repository, as `git status` sees it. */
export interface GitStatus {
  /** The repository's top folder, reached from the conversation's folder (so through its symlinks). */
  root: string
  /** null: HEAD is detached. */
  branch: string | null
  /** null: no commits yet. */
  head: string | null
  /** The branch's upstream, e.g. origin/main; null when it has none. */
  upstream: string | null
  ahead: number
  behind: number
  /** Where pushing a branch without an upstream goes: origin, else the first remote; null without remotes. */
  remote: string | null
  conflicts: GitChange[]
  staged: GitChange[]
  /** Changes in the working tree, untracked files included. */
  unstaged: GitChange[]
  /** Every change; the lists stop at a limit, this does not. */
  count: number
}

export interface DirEntry {
  name: string
  path: string
  /** A symlink counts as what it points to. */
  dir: boolean
  /** Ignored by git (shown dimmed). */
  ignored: boolean
}

/** A file's content as the editor gets it. */
export type FileContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mediaType: string; data: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'missing' }

/** Where a side of an editor's content comes from. rev: '' the index, 'HEAD', or a commit. */
export type Source = { kind: 'file'; path: string } | { kind: 'git'; root: string; rev: string; path: string }

export interface SearchQuery {
  pattern: string
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
  /** Comma-separated globs, as VS Code's "files to include" and "files to exclude". */
  include: string
  exclude: string
}

export interface SearchMatch {
  /** 1-based. */
  line: number
  /** 1-based, in characters of the whole line. */
  column: number
  length: number
  /** Part of the line around the match, which is at [start, start + length) of it. */
  preview: string
  start: number
}

export interface SearchFile {
  /** Relative to the searched folder. */
  path: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFile[]
  matchCount: number
  /** The search stopped at the result limit. */
  limitHit: boolean
}

export type GitOp =
  | { kind: 'stage' | 'unstage' | 'discard'; changes: GitChange[] }
  /** push: push the commit too. */
  | { kind: 'commit'; message: string; amend: boolean; push: boolean }
  | { kind: 'push' | 'pull' | 'fetch' | 'init' }
  | { kind: 'checkout'; branch: string }

export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  /** Epoch milliseconds. */
  date: number
  subject: string
  /** Refs pointing at it, as `git log --decorate=full --format=%D` lists them: `HEAD -> refs/heads/main`, `refs/tags/v1`. */
  refs: string[]
}

/** The hash git blame gives lines that are not committed. */
export const UNCOMMITTED = '0000000000000000000000000000000000000000'

export interface BlameCommit {
  author: string
  email: string
  /** Epoch milliseconds. */
  date: number
  summary: string
  /** The file's repository-relative path in the commit, which a rename since makes another. */
  filename: string
}

/** Who last changed each line of a file's text, as `git blame` tells it. */
export interface Blame {
  /** Each line's commit hash; UNCOMMITTED for a line no commit has. */
  lines: string[]
  commits: Record<string, BlameCommit>
  /** The user's `user.email`, whose commits say "You"; null when unset. */
  you: string | null
}

export interface MenuItem {
  id: string
  label: string
  /** An Electron accelerator shown beside the label, e.g. "CmdOrCtrl+S"; the menu does not bind it. */
  accelerator?: string
  enabled?: boolean
  separator?: boolean
}

export interface CodeApi {
  /** Whether this window shows a conversation in the folder, and so wants its changes. */
  watchFolder(cwd: string, watching: boolean): void
  /** The folder's repository; null when it is in none. */
  gitStatus(cwd: string): Promise<GitStatus | null>
  listDir(cwd: string, dir: string): Promise<DirEntry[]>
  readSource(source: Source): Promise<FileContent>
  writeFile(path: string, text: string): Promise<void>
  createFile(path: string, dir: boolean): Promise<void>
  renamePath(from: string, to: string): Promise<void>
  /** Moves to the Trash after the user confirms; false when they did not. */
  trashPath(path: string): Promise<boolean>
  revealPath(path: string): void
  /** Every file in the folder, relative, as VS Code's quick open lists them. */
  listFiles(cwd: string): Promise<string[]>
  /** A new search replaces this window's search in the folder, which then resolves to null. */
  search(cwd: string, query: SearchQuery): Promise<SearchResult | null>
  /** Runs a git command on the folder's repository. Discarding asks the user first; false when they declined. */
  git(cwd: string, op: GitOp): Promise<boolean>
  gitLog(cwd: string, count: number): Promise<GitCommit[]>
  /** What a commit changed, against its first parent. */
  commitChanges(cwd: string, hash: string): Promise<GitChange[]>
  branches(cwd: string): Promise<string[]>
  /**
   * Blames the file at `path` (repository-relative) as of `rev`, or with rev null `text` as its content
   * on top of HEAD; null when that revision does not have the file.
   */
  blame(root: string, path: string, text: string | null, rev: string | null): Promise<Blame | null>
  /** A commit's whole message. */
  commitMessage(root: string, hash: string): Promise<string>
  /** A native menu at the pointer; the picked item's id, or null. */
  showMenu(items: MenuItem[]): Promise<string | null>
  /** A native message box; the index of the button clicked. */
  ask(message: string, detail: string, buttons: string[]): Promise<number>
  /**
   * Files in a watched folder changed: `paths` (null: too many to list), and the repository's
   * status after them.
   */
  onFolderChanged(cb: (cwd: string, paths: string[] | null, status: GitStatus | null) => void): () => void
}
