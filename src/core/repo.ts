// A project's git repository, as the code view shows and changes it.

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { Blame, GitChange, GitCommit, GitLetter, GitStatus } from '@shared/code'

/** How many changes of each kind a status lists; `count` counts them all. */
const LIST_LIMIT = 5000

export interface RepoInfo {
  /** The repository's top folder, reached from the folder asked about. */
  root: string
  gitDir: string
}

class GitError extends Error {}

/**
 * Runs git and collects its output. Exit codes in `codes` count as success. Optional
 * locks are off, so reading the status never rewrites the index (which would wake the
 * folder's watcher again), and git never waits on a credential prompt nobody sees.
 */
export function runGit(cwd: string, args: string[], opts: { input?: string; codes?: number[] } = {}): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((done, fail) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', fail)
    child.on('close', (code) => {
      const ok = code === 0 || (code !== null && (opts.codes ?? []).includes(code))
      if (ok) done({ stdout: Buffer.concat(out), code: code ?? 0 })
      else fail(new GitError(Buffer.concat(err).toString().trim() || `git ${args[0]} exited with ${code}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

async function gitText(cwd: string, args: string[], input?: string): Promise<string> {
  return (await runGit(cwd, args, { input })).stdout.toString()
}

/** The folder's repository; null when it is in none. */
export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
  const result = await runGit(cwd, ['rev-parse', '--show-cdup', '--absolute-git-dir'], { codes: [128] })
  if (result.code === 128) return null
  const [cdup = '', gitDir = ''] = result.stdout.toString().split('\n')
  return { root: resolve(cwd, cdup), gitDir }
}

export async function status(root: string): Promise<GitStatus> {
  const [out, remotes] = await Promise.all([gitText(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']), gitText(root, ['remote'])])
  const names = remotes.split('\n').filter(Boolean)
  return { ...parseStatus(out, root), remote: names.includes('origin') ? 'origin' : (names[0] ?? null) }
}

/** `git status --porcelain=v2 -z --branch` → the code view's status. */
export function parseStatus(out: string, root: string): GitStatus {
  const s: GitStatus = { root, branch: null, head: null, upstream: null, ahead: 0, behind: 0, remote: null, conflicts: [], staged: [], unstaged: [], count: 0 }
  const add = (list: GitChange[], change: GitChange): void => {
    s.count++
    if (list.length < LIST_LIMIT) list.push(change)
  }
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (!f) continue
    const parts = f.split(' ')
    if (f.startsWith('# ')) {
      const [, key, value = '', value2 = ''] = parts
      if (key === 'branch.oid') s.head = value === '(initial)' ? null : value
      else if (key === 'branch.head') s.branch = value === '(detached)' ? null : parts.slice(2).join(' ')
      else if (key === 'branch.upstream') s.upstream = parts.slice(2).join(' ')
      else if (key === 'branch.ab') {
        s.ahead = Math.abs(Number(value))
        s.behind = Math.abs(Number(value2))
      }
    } else if (f[0] === '1' || f[0] === '2') {
      const xy = parts[1] ?? '..'
      const path = parts.slice(f[0] === '1' ? 8 : 9).join(' ')
      const origPath = f[0] === '2' ? (fields[++i] ?? null) : null
      const [x = '.', y = '.'] = xy
      if (x !== '.') add(s.staged, { path, origPath: 'RC'.includes(x) ? origPath : null, letter: x as GitLetter })
      if (y !== '.') add(s.unstaged, { path, origPath: 'RC'.includes(y) ? origPath : null, letter: y as GitLetter })
    } else if (f[0] === 'u') {
      const xy = parts[1] ?? ''
      add(s.conflicts, { path: parts.slice(10).join(' '), origPath: null, letter: xy === 'UD' || xy === 'DU' ? 'D' : '!' })
    } else if (f[0] === '?') {
      add(s.unstaged, { path: f.slice(2), origPath: null, letter: 'U' })
    }
  }
  return s
}

/** Which of the repository-relative paths git ignores. */
export async function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  // Exit 1: none of them is ignored.
  const result = await runGit(root, ['check-ignore', '-z', '--stdin'], { input: paths.join('\0') + '\0', codes: [1] })
  return new Set(result.stdout.toString().split('\0').filter(Boolean))
}

/** A file's bytes at a revision ('' for the index); null when it is not there. */
export async function fileAt(root: string, rev: string, path: string): Promise<Buffer | null> {
  const result = await runGit(root, ['cat-file', 'blob', `${rev}:${path}`], { codes: [128] })
  return result.code === 128 ? null : result.stdout
}

export async function stage(root: string, changes: GitChange[]): Promise<void> {
  if (changes.length === 0) return
  // -A also stages deletions of the paths given.
  await runGit(root, ['add', '-A', '--', ...pathsOf(changes)])
}

export async function unstage(root: string, changes: GitChange[], hasHead: boolean): Promise<void> {
  if (changes.length === 0) return
  // A rename unstages both of its sides, so the old path is back in the index too.
  const paths = [...pathsOf(changes), ...changes.flatMap((c) => (c.origPath ? [c.origPath] : []))]
  if (hasHead) await runGit(root, ['reset', '-q', '--', ...paths])
  else await runGit(root, ['rm', '--cached', '-r', '-q', '--', ...paths])
}

/** Drops working-tree changes to tracked files, back to what the index has. */
export async function discardTracked(root: string, changes: GitChange[]): Promise<void> {
  if (changes.length === 0) return
  await runGit(root, ['checkout', '-q', '--', ...pathsOf(changes)])
}

export async function stageAll(root: string): Promise<void> {
  await runGit(root, ['add', '-A'])
}

export async function commit(root: string, message: string, amend: boolean): Promise<void> {
  await runGit(root, ['commit', '-q', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message })
}

export async function push(root: string, s: GitStatus): Promise<void> {
  if (s.upstream) {
    await runGit(root, ['push'])
    return
  }
  if (!s.branch) throw new GitError('HEAD is detached: check out a branch to push it')
  if (!s.remote) throw new GitError('The repository has no remote to push to')
  await runGit(root, ['push', '-u', s.remote, s.branch])
}

export async function pull(root: string, s: GitStatus): Promise<void> {
  if (!s.upstream) throw new GitError(`${s.branch ?? 'HEAD'} has no upstream branch to pull from`)
  await runGit(root, ['pull'])
}

export async function fetch(root: string): Promise<void> {
  await runGit(root, ['fetch'])
}

export async function init(cwd: string): Promise<void> {
  await runGit(cwd, ['init', '-q'])
}

export async function localBranches(root: string): Promise<string[]> {
  return (await gitText(root, ['branch', '--format=%(refname:short)'])).split('\n').filter(Boolean)
}

export async function checkout(root: string, branch: string): Promise<void> {
  await runGit(root, ['checkout', '-q', branch])
}

/** The latest commits of HEAD and its upstream, children before their parents. */
export async function log(root: string, s: GitStatus, count: number): Promise<GitCommit[]> {
  if (!s.head) return []
  const revs = ['HEAD', ...(s.upstream ? [s.upstream] : [])]
  // Full ref names tell local branches, remote ones and tags apart.
  const out = await gitText(root, ['log', '--topo-order', '--decorate=full', `-n${count}`, '--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e', ...revs, '--'])
  return parseLog(out)
}

export function parseLog(out: string): GitCommit[] {
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash = '', parents = '', author = '', at = '0', refs = '', subject = ''] = record.split('\x1f')
      return { hash, parents: parents.split(' ').filter(Boolean), author, date: Number(at) * 1000, subject, refs: refs ? refs.split(', ') : [] }
    })
}

/** What a commit changed against its first parent (everything, for a root commit). */
export async function commitChanges(root: string, hash: string): Promise<GitChange[]> {
  const parents = (await gitText(root, ['rev-list', '--parents', '-n1', hash])).trim().split(' ').slice(1)
  const range = parents[0] ? [parents[0], hash] : ['--root', hash]
  const out = await gitText(root, ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', ...range])
  return parseNameStatus(out)
}

/** `git diff-tree --name-status -z` → changes. */
export function parseNameStatus(out: string): GitChange[] {
  const fields = out.split('\0')
  const changes: GitChange[] = []
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]
    if (!code) continue
    const letter = code[0] as GitLetter
    if (letter === 'R' || letter === 'C') {
      const origPath = fields[++i] ?? ''
      changes.push({ path: fields[++i] ?? '', origPath, letter })
    } else changes.push({ path: fields[++i] ?? '', origPath: null, letter })
  }
  return changes
}

/**
 * Blames the file as of a revision, or with rev null `text` as its content (an editor's, unsaved
 * changes included), whose lines that differ from HEAD's history are uncommitted. Null when the
 * revision does not have the file.
 */
export async function blame(root: string, path: string, text: string | null, rev: string | null): Promise<Blame | null> {
  const args = rev ? ['blame', '--porcelain', rev, '--', path] : ['blame', '--porcelain', '--contents', '-', '--', path]
  const [result, email] = await Promise.all([
    runGit(root, args, { input: text ?? '', codes: [128] }),
    runGit(root, ['config', 'user.email'], { codes: [1] }),
  ])
  if (result.code === 128) return null
  return { ...parseBlame(result.stdout.toString()), you: email.stdout.toString().trim() || null }
}

/** `git blame --porcelain` → each line's commit, and the commits. */
export function parseBlame(out: string): Omit<Blame, 'you'> {
  const lines: string[] = []
  const commits: Blame['commits'] = {}
  let hash = ''
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
    if (header) {
      hash = header[1] ?? ''
      lines[Number(header[2]) - 1] = hash
      commits[hash] ??= { author: '', email: '', date: 0, summary: '', filename: '' }
      continue
    }
    const commit = commits[hash]
    if (!commit || line.startsWith('\t')) continue
    const space = line.indexOf(' ')
    const key = line.slice(0, space)
    const value = line.slice(space + 1)
    if (key === 'author') commit.author = value
    else if (key === 'author-mail') commit.email = value.replace(/^<|>$/g, '')
    else if (key === 'author-time') commit.date = Number(value) * 1000
    else if (key === 'summary') commit.summary = value
    else if (key === 'filename') commit.filename = value
  }
  return { lines, commits }
}

export async function commitMessage(root: string, hash: string): Promise<string> {
  return (await gitText(root, ['log', '-1', '--format=%B', hash, '--'])).trimEnd()
}

function pathsOf(changes: GitChange[]): string[] {
  return changes.map((c) => c.path)
}
