import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentOf, searchGlobs } from './files'

describe('searchGlobs', () => {
  it('turns plain names into files or folders anywhere', () => {
    expect(searchGlobs('src, *.ts', false)).toEqual(['**/src', '**/src/**', '*.ts'])
    expect(searchGlobs('./src/core', true)).toEqual(['!src/core', '!src/core/**'])
    expect(searchGlobs(' , ', false)).toEqual([])
  })
})

describe('contentOf', () => {
  it('tells text, images and binary files apart', () => {
    expect(contentOf(Buffer.from('hello'), 'a.ts')).toEqual({ kind: 'text', text: 'hello' })
    expect(contentOf(Buffer.from([1, 0, 2]), 'a.bin')).toEqual({ kind: 'binary', size: 3 })
    expect(contentOf(Buffer.from([1, 0, 2]), 'a.PNG')).toMatchObject({ kind: 'image', mediaType: 'image/png', size: 3 })
  })
})

describe('the bundled ripgrep', () => {
  it('lists and searches files', async () => {
    const { listFiles, searchFiles } = await import('./files')
    const dir = mkdtempSync(join(tmpdir(), 'kumi-files-'))
    writeFileSync(join(dir, 'a.txt'), 'one ünïcode needle\ntwo\n')
    writeFileSync(join(dir, '.hidden'), 'needle')
    expect((await listFiles(dir)).sort()).toEqual(['.hidden', 'a.txt'])
    const result = await searchFiles(dir, { pattern: 'NEEDLE', matchCase: false, wholeWord: false, regex: false, include: '*.txt', exclude: '' }).result
    expect(result?.files).toEqual([{ path: 'a.txt', matches: [{ line: 1, column: 13, length: 6, preview: 'one ünïcode needle', start: 12 }] }])
  })
})
