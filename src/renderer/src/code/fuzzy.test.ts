import { describe, expect, it } from 'vitest'
import { fuzzyMatch, matchFiles } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches characters in order, case-insensitively', () => {
    expect(fuzzyMatch('Conversation.svelte', 'cvs')?.positions).toEqual([0, 3, 13])
    expect(fuzzyMatch('abc', 'acb')).toBeNull()
    expect(fuzzyMatch('ab', 'abc')).toBeNull()
  })

  it('prefers runs and word starts', () => {
    expect(fuzzyMatch('browser-tools.ts', 'tools')?.positions).toEqual([8, 9, 10, 11, 12])
    expect(fuzzyMatch('TabStrip.js', 'ts')?.positions).toEqual([0, 3])
    const run = fuzzyMatch('state.ts', 'sta')?.score ?? 0
    const spread = fuzzyMatch('s_t_a', 'sta')?.score ?? 0
    expect(run).toBeGreaterThan(spread)
  })
})

describe('matchFiles', () => {
  const paths = ['src/renderer/src/App.svelte', 'src/main/index.ts', 'src/renderer/src/state.svelte.ts', 'src/core/store.ts', 'e2e/launch.mjs']

  it('ranks matches in the file name first', () => {
    const results = matchFiles(paths, 'st', 10).map((m) => m.path)
    expect(results.slice(0, 2).sort()).toEqual(['src/core/store.ts', 'src/renderer/src/state.svelte.ts'])
  })

  it('matches folders with a slash, and every word', () => {
    expect(matchFiles(paths, 'main/ind', 10).map((m) => m.path)).toEqual(['src/main/index.ts'])
    expect(matchFiles(paths, 'renderer app', 10).map((m) => m.path)).toEqual(['src/renderer/src/App.svelte'])
  })

  it('reports where the name and folder matched', () => {
    const [m] = matchFiles(paths, 'core/sto', 1)
    expect(m).toMatchObject({ path: 'src/core/store.ts', description: [4, 5, 6, 7, 8], label: [0, 1, 2] })
  })
})
