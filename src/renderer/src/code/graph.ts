// The commit graph's lanes, as VS Code's source control graph draws them: each commit on
// the lane of the child that reached it first, a first parent continuing its child's lane,
// other parents branching off to lanes of their own.

import type { GitCommit } from '@shared/code'

/** A line in one half of a row, from a lane at the half's top to a lane at its bottom. */
export interface GraphEdge {
  from: number
  to: number
  color: number
}

export interface GraphRow {
  commit: GitCommit
  lane: number
  color: number
  /** From the row's top edge to the commit. */
  top: GraphEdge[]
  /** From the commit down to the row's bottom edge. */
  bottom: GraphEdge[]
  /** Lanes the row spans. */
  width: number
}

interface Lane {
  /** The commit the lane goes on to. */
  hash: string
  color: number
}

/** Rows for commits in topological order (children before their parents). */
export function layoutGraph(commits: GitCommit[]): GraphRow[] {
  let lanes: (Lane | null)[] = []
  let colors = 0
  const rows: GraphRow[] = []
  for (const commit of commits) {
    const top: GraphEdge[] = []
    let lane = lanes.findIndex((l) => l?.hash === commit.hash)
    // Lanes coming down: those reaching this commit end at it, the others pass by.
    lanes.forEach((l, i) => l && top.push({ from: i, to: l.hash === commit.hash ? lane : i, color: l.color }))
    let color: number
    if (lane === -1) {
      // A tip: no child above it.
      lane = free(lanes)
      color = colors++
    } else color = lanes[lane]?.color ?? 0
    const next = lanes.map((l) => (l?.hash === commit.hash ? null : l))
    const bottom: GraphEdge[] = []
    const reached = new Set<number>()
    commit.parents.forEach((parent, k) => {
      let to = next.findIndex((l) => l?.hash === parent)
      // The first parent stays on this lane unless a lane to its left goes there: lanes further
      // left are the main line, and two lanes reaching one commit join at it.
      if (k === 0 && (to === -1 || to > lane) && !next[lane]) {
        to = lane
        next[to] = { hash: parent, color }
      } else if (to === -1) {
        to = free(next)
        next[to] = { hash: parent, color: colors++ }
      }
      reached.add(to)
      bottom.push({ from: lane, to, color: next[to]?.color ?? color })
    })
    next.forEach((l, i) => l && !reached.has(i) && bottom.push({ from: i, to: i, color: l.color }))
    while (next.length > 0 && next.at(-1) === null) next.pop()
    rows.push({ commit, lane, color, top, bottom, width: Math.max(lanes.length, next.length, lane + 1) })
    lanes = next
  }
  return rows
}

function free(lanes: (Lane | null)[]): number {
  const i = lanes.indexOf(null)
  return i === -1 ? lanes.length : i
}
