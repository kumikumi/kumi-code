// What Kumi Code asks git about a project.

import { execFile } from 'node:child_process'

/** Whether the folder is in a git repository with changes to commit: staged, unstaged or untracked. */
export function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return new Promise((done) => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: 10_000 }, (err, stdout) => done(!err && stdout.trim().length > 0))
  })
}
