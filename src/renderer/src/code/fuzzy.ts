// Fuzzy matching for quick open, after VS Code's: the query's characters in order, scored
// higher in a row, at the start of a word or path segment, and with the same case; a match in
// the file's name beats one spread over its folders.

export interface FuzzyMatch {
  score: number
  /** Indexes of the matched characters in the target. */
  positions: number[]
}

/** VS Code's bonus for a character after a separator: path separators count more. */
function separatorBonus(c: string | undefined): number {
  if (c === '/' || c === '\\') return 5
  return c !== undefined && '_-. \'":'.includes(c) ? 4 : 0
}

/** The best match of `query` in `target`, or null when its characters are not all there in order. */
export function fuzzyMatch(target: string, query: string): FuzzyMatch | null {
  const n = target.length
  const m = query.length
  if (m === 0) return { score: 0, positions: [] }
  if (m > n) return null
  const lowerTarget = target.toLowerCase()
  const lowerQuery = query.toLowerCase()
  // Quick rejection: are the characters there in order at all?
  for (let i = 0, j = 0; j < m; i++) {
    if (i >= n) return null
    if (lowerTarget[i] === lowerQuery[j]) j++
  }
  // For query[j] at target[i] (index j * n + i): the best score of query[0..j], where query[j - 1]
  // was, and how many characters in a row end there.
  const best = new Float64Array(m * n).fill(-Infinity)
  const from = new Int32Array(m * n).fill(-1)
  const run = new Int32Array(m * n)
  for (let j = 0; j < m; j++) {
    // The best score of query[0..j-1] ending two or more characters before i, and where.
    let gapBest = -Infinity
    let gapAt = -1
    for (let i = j; i < n; i++) {
      if (j > 0 && i >= 2) {
        const prev = best[(j - 1) * n + i - 2] ?? -Infinity
        if (prev > gapBest) {
          gapBest = prev
          gapAt = i - 2
        }
      }
      if (lowerTarget[i] !== lowerQuery[j]) continue
      const c = target[i] ?? ''
      // VS Code's character score: the match, the same case, the start, a separator before it.
      let score = 1 + (c === query[j] ? 1 : 0) + (i === 0 ? 8 : separatorBonus(target[i - 1]))
      const camel = i > 0 && !separatorBonus(target[i - 1]) && c !== c.toLowerCase() ? 2 : 0
      const at = j * n + i
      if (j === 0) {
        best[at] = score + camel
        run[at] = 1
        continue
      }
      const adjacent = best[(j - 1) * n + i - 1] ?? -Infinity
      const length = run[(j - 1) * n + i - 1] ?? 0
      // A run's bonus grows with its length, as in VS Code.
      const inRun = adjacent + score + Math.min(length, 3) * 6 + Math.max(0, length - 3) * 3
      const afterGap = gapBest + score + camel
      if (adjacent > -Infinity && inRun >= afterGap) {
        best[at] = inRun
        from[at] = i - 1
        run[at] = length + 1
      } else if (gapBest > -Infinity) {
        best[at] = afterGap
        from[at] = gapAt
        run[at] = 1
      }
    }
  }
  let score = -Infinity
  let at = -1
  for (let i = m - 1; i < n; i++) {
    const s = best[(m - 1) * n + i] ?? -Infinity
    if (s > score) {
      score = s
      at = i
    }
  }
  if (at < 0) return null
  const positions: number[] = []
  for (let j = m - 1; j >= 0 && at >= 0; j--) {
    positions.push(at)
    at = from[j * n + at] ?? -1
  }
  return { score, positions: positions.reverse() }
}

export interface FileMatch {
  path: string
  score: number
  /** Matched character indexes in the file's name and in its folder. */
  label: number[]
  description: number[]
}

/** A match in the name counts this much more than one over the whole path. */
const LABEL_BONUS = 1 << 16

/**
 * Ranks relative paths for a quick open query: words separated by spaces each match, a
 * query with a slash matches the whole path, else the name first.
 */
export function matchFiles(paths: string[], query: string, limit: number): FileMatch[] {
  const pieces = query.replace(/\\/g, '/').split(' ').filter(Boolean)
  if (pieces.length === 0) return []
  const matches: FileMatch[] = []
  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const name = path.slice(slash + 1)
    let score = 0
    const label: number[] = []
    const description: number[] = []
    let ok = true
    for (const piece of pieces) {
      const inName = piece.includes('/') ? null : fuzzyMatch(name, piece)
      if (inName) {
        score += inName.score + LABEL_BONUS + (name.toLowerCase().startsWith(piece.toLowerCase()) ? LABEL_BONUS : 0)
        label.push(...inName.positions)
        continue
      }
      const inPath = fuzzyMatch(path, piece)
      if (!inPath) {
        ok = false
        break
      }
      score += inPath.score
      for (const p of inPath.positions) (p > slash ? label : description).push(p > slash ? p - slash - 1 : p)
    }
    if (ok) matches.push({ path, score, label, description })
  }
  return matches
    .sort((a, b) => b.score - a.score || nameLength(a.path) - nameLength(b.path) || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
}

function nameLength(path: string): number {
  return path.length - path.lastIndexOf('/') - 1
}
