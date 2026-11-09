import { describe, expect, it } from 'vitest'
import { parseBlame, parseLog, parseNameStatus, parseStatus } from './repo'

describe('parseStatus', () => {
  it('reads the branch, staged, unstaged, untracked and conflicted files', () => {
    const out = [
      '# branch.oid 1100c26aaaa',
      '# branch.head master',
      '# branch.upstream origin/master',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
      '1 .M N... 100644 100644 100644 aaa aaa src/with space.ts',
      '1 MD N... 100644 100644 000000 aaa bbb both.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      'u DU N... 100644 100644 100644 100644 a b c gone.ts',
      '? untracked.txt',
      '',
    ].join('\0')
    const s = parseStatus(out, '/repo')
    expect(s).toMatchObject({ root: '/repo', branch: 'master', head: '1100c26aaaa', upstream: 'origin/master', ahead: 2, behind: 1, count: 8 })
    expect(s.staged).toEqual([
      { path: 'src/a.ts', origPath: null, letter: 'M' },
      { path: 'both.ts', origPath: null, letter: 'M' },
      { path: 'new.ts', origPath: 'old.ts', letter: 'R' },
    ])
    expect(s.unstaged).toEqual([
      { path: 'src/with space.ts', origPath: null, letter: 'M' },
      { path: 'both.ts', origPath: null, letter: 'D' },
      { path: 'untracked.txt', origPath: null, letter: 'U' },
    ])
    expect(s.conflicts).toEqual([
      { path: 'conflict.ts', origPath: null, letter: '!' },
      { path: 'gone.ts', origPath: null, letter: 'D' },
    ])
  })

  it('reads a new repository and a detached HEAD', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0', '/r')).toMatchObject({ head: null, branch: 'main', upstream: null })
    expect(parseStatus('# branch.oid abc\0# branch.head (detached)\0', '/r')).toMatchObject({ head: 'abc', branch: null })
  })
})

describe('parseNameStatus', () => {
  it('reads changes and renames', () => {
    expect(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0A\0b c.ts\0')).toEqual([
      { path: 'a.ts', origPath: null, letter: 'M' },
      { path: 'new.ts', origPath: 'old.ts', letter: 'R' },
      { path: 'b c.ts', origPath: null, letter: 'A' },
    ])
  })
})

describe('parseLog', () => {
  it('reads commits with their parents and refs', () => {
    const out = 'aaa\x1fbbb ccc\x1fMikko\x1f1700000000\x1fHEAD -> master, origin/master\x1fMerge it\x1e\nbbb\x1f\x1fMikko\x1f1690000000\x1f\x1fFirst\x1e\n'
    expect(parseLog(out)).toEqual([
      { hash: 'aaa', parents: ['bbb', 'ccc'], author: 'Mikko', date: 1700000000000, subject: 'Merge it', refs: ['HEAD -> master', 'origin/master'] },
      { hash: 'bbb', parents: [], author: 'Mikko', date: 1690000000000, subject: 'First', refs: [] },
    ])
  })
})

describe('parseBlame', () => {
  it("reads each line's commit, uncommitted lines included", () => {
    const a = '0df893097a57abf597c71f13e841a97b36b072bd'
    const zero = '0000000000000000000000000000000000000000'
    const out = [
      `${a} 1 1 1`,
      'author Tester',
      'author-mail <t@example.com>',
      'author-time 1793969996',
      'summary Initial commit',
      'boundary',
      'filename src/lib/math.ts',
      '\texport function add(a: number, b: number): number {',
      `${zero} 2 2 1`,
      'author External file (--contents)',
      'author-mail <external.file>',
      'author-time 1793978786',
      'summary Version of src/lib/math.ts from standard input',
      'filename src/lib/math.ts',
      '\t  // edited',
      `${a} 2 3 2`,
      '\t  return a + b',
      `${a} 3 4`,
      '\t}',
      '',
    ].join('\n')
    const blame = parseBlame(out)
    expect(blame.lines).toEqual([a, zero, a, a])
    expect(blame.commits[a]).toEqual({ author: 'Tester', email: 't@example.com', date: 1793969996000, summary: 'Initial commit', filename: 'src/lib/math.ts' })
  })
})
