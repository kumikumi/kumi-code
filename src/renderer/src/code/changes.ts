// What the editor's gutter marks: how a file's text differs from its version in git's index,
// line by line, as VS Code's quick diff does.

import { diffLines } from 'diff'

/**
 * Lines of the current text, 1-based and inclusive. A deletion lies between lines: after `start`
 * (0: before the first), with `end` equal to it.
 */
export interface LineChange {
  kind: 'added' | 'modified' | 'deleted'
  start: number
  end: number
}

/** Past this many changed lines the gutter shows none, as the diff would take too long. */
const MAX_EDIT = 5000

export function lineChanges(original: string, current: string): LineChange[] {
  if (original === current) return []
  const parts = diffLines(original, current, { maxEditLength: MAX_EDIT, stripTrailingCr: true, ignoreNewlineAtEof: true })
  if (!parts) return []
  const changes: LineChange[] = []
  let line = 1
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const count = part.count ?? 0
    if (!part.added && !part.removed) line += count
    else if (part.added) {
      changes.push({ kind: 'added', start: line, end: line + count - 1 })
      line += count
    } else {
      // A removal followed by an addition is a modification of the added lines.
      const added = parts[i + 1]?.added ? (parts[i + 1]?.count ?? 0) : 0
      if (added) {
        changes.push({ kind: 'modified', start: line, end: line + added - 1 })
        line += added
        i++
      } else changes.push({ kind: 'deleted', start: line - 1, end: line - 1 })
    }
  }
  return changes
}
