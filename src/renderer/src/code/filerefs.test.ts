import { describe, expect, it } from 'vitest'
import { isFileHref, looksLikeFileRef, parseFileRef, resolvePath } from './filerefs'

describe('isFileHref', () => {
  it('tells file paths from pages', () => {
    for (const href of ['src/foo.ts', 'src/foo.ts:42', 'README.md:12', './a.ts', '/abs/b.ts', 'file:///abs/c.ts']) expect(isFileHref(href)).toBe(true)
    for (const href of ['https://example.com', 'mailto:a@b.c', '#terminal/0', '//cdn.example.com/x.js', 'localhost:3000', '']) expect(isFileHref(href)).toBe(false)
  })
})

describe('looksLikeFileRef', () => {
  it('takes paths with an extension and maybe a line', () => {
    for (const text of ['src/foo.ts', 'src/foo.ts:42', 'package.json', 'a/b.svelte:3:7', 'x.ts:10-20', './rel.md', '/abs/path.ts']) expect(looksLikeFileRef(text)).toBe(true)
    for (const text of ['npm run dev', 'src/core', 'foo()', 'a b.ts', 'x.ts:']) expect(looksLikeFileRef(text)).toBe(false)
  })
})

describe('parseFileRef', () => {
  it('reads the line and column in their usual forms', () => {
    expect(parseFileRef('src/foo.ts')).toEqual({ path: 'src/foo.ts' })
    expect(parseFileRef('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42, column: undefined })
    expect(parseFileRef('src/foo.ts:42:7')).toEqual({ path: 'src/foo.ts', line: 42, column: 7 })
    expect(parseFileRef('src/foo.ts:42-50')).toEqual({ path: 'src/foo.ts', line: 42, column: undefined })
    expect(parseFileRef('src/foo.ts#L12C3')).toEqual({ path: 'src/foo.ts', line: 12, column: 3 })
    expect(parseFileRef('file:///a/my%20file.ts:3')).toEqual({ path: '/a/my file.ts', line: 3, column: undefined })
  })
})

describe('resolvePath', () => {
  it('resolves against the working directory', () => {
    expect(resolvePath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolvePath('/repo/sub', '../b.ts')).toBe('/repo/b.ts')
    expect(resolvePath('/repo', './c/./d.ts')).toBe('/repo/c/d.ts')
    expect(resolvePath('/repo', '/etc/hosts')).toBe('/etc/hosts')
  })
})
