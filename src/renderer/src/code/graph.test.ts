import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@shared/code'
import { layoutGraph } from './graph'

const commit = (hash: string, ...parents: string[]): GitCommit => ({ hash, parents, author: '', date: 0, subject: hash, refs: [] })

describe('layoutGraph', () => {
  it('keeps a straight history on one lane', () => {
    const rows = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows[1]).toMatchObject({ top: [{ from: 0, to: 0 }], bottom: [{ from: 0, to: 0 }] })
    expect(rows[2]?.bottom).toEqual([])
  })

  it('branches a merge off and joins it back', () => {
    // m merges f (a side branch off a) into b.
    const rows = layoutGraph([commit('m', 'b', 'f'), commit('f', 'a'), commit('b', 'a'), commit('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0])
    expect(rows[0]?.bottom.map((e) => [e.from, e.to])).toEqual([
      [0, 0],
      [0, 1],
    ])
    // b passes by f's lane; at a, both lanes end in it.
    expect(rows[2]?.top.map((e) => [e.from, e.to])).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(rows[3]?.top.map((e) => [e.from, e.to])).toEqual([
      [0, 0],
      [1, 0],
    ])
    expect(rows[1]?.color).not.toBe(rows[0]?.color)
  })

  it('gives a second tip a lane of its own', () => {
    const rows = layoutGraph([commit('x', 'a'), commit('y', 'a'), commit('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0])
    expect(rows[1]?.top.map((e) => [e.from, e.to])).toEqual([[0, 0]])
  })
})
