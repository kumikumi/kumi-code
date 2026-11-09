import { describe, expect, it } from 'vitest'
import { lineChanges } from './changes'

describe('lineChanges', () => {
  const original = 'a\nb\nc\nd\n'

  it('finds nothing in the same text', () => {
    expect(lineChanges(original, original)).toEqual([])
  })

  it('marks added, modified and deleted lines', () => {
    expect(lineChanges(original, 'a\nnew\nb\nc\nd\n')).toEqual([{ kind: 'added', start: 2, end: 2 }])
    expect(lineChanges(original, 'a\nB\nc\nd\n')).toEqual([{ kind: 'modified', start: 2, end: 2 }])
    expect(lineChanges(original, 'a\nc\nd\n')).toEqual([{ kind: 'deleted', start: 1, end: 1 }])
    expect(lineChanges(original, 'b\nc\nd\n')).toEqual([{ kind: 'deleted', start: 0, end: 0 }])
  })

  it('counts lines after earlier changes, and ignores a missing last newline', () => {
    expect(lineChanges(original, 'x\ny\na\nb\nc\nD')).toEqual([
      { kind: 'added', start: 1, end: 2 },
      { kind: 'modified', start: 6, end: 6 },
    ])
    expect(lineChanges(original, 'a\nb\nc\nd')).toEqual([])
  })
})
