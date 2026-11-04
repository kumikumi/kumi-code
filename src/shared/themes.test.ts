import { describe, expect, it } from 'vitest'
import { randomTheme, THEMES } from './themes'

describe('randomTheme', () => {
  const draws = (n: number) => Array.from({ length: n }, (_, i) => () => i / n)

  it('can pick every theme but the one left out, and never that one', () => {
    const picked = new Set(draws(70).map((random) => randomTheme('pine', random)))
    expect(picked.has('pine')).toBe(false)
    expect(picked.size).toBe(THEMES.length - 1)
  })

  it('can pick any theme when none is left out', () => {
    expect(new Set(draws(80).map((random) => randomTheme(null, random))).size).toBe(THEMES.length)
  })

  it('fails on a random number outside [0, 1)', () => {
    expect(() => randomTheme(null, () => 1)).toThrow()
  })
})
