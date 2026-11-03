// Renders resources/icon.svg into resources/icon.icns: `bun run icon`, then `bun install` to put
// it on the development app.

import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const resources = resolve(import.meta.dirname, '../resources')
// The sizes, in points, that a macOS iconset holds at 1x and 2x.
const points = [16, 32, 128, 256, 512]

app.dock?.hide()
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  await window.loadURL('about:blank')
  const svg = readFileSync(join(resources, 'icon.svg')).toString('base64')
  const pixels = [...new Set(points.flatMap((p) => [p, p * 2]))]
  // Drawn into a canvas at each size, the SVG renders as vectors there rather than as a scaled bitmap.
  const pngs = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image()
    image.src = 'data:image/svg+xml;base64,${svg}'
    await image.decode()
    return Object.fromEntries(${JSON.stringify(pixels)}.map((size) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      canvas.getContext('2d').drawImage(image, 0, 0, size, size)
      return [size, canvas.toDataURL('image/png')]
    }))
  })()`)
  const dir = mkdtempSync(join(tmpdir(), 'kumi-icon-'))
  const iconset = join(dir, 'icon.iconset')
  mkdirSync(iconset)
  const png = (size) => Buffer.from(pngs[size].split(',')[1], 'base64')
  for (const p of points) {
    writeFileSync(join(iconset, `icon_${p}x${p}.png`), png(p))
    writeFileSync(join(iconset, `icon_${p}x${p}@2x.png`), png(p * 2))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')])
  rmSync(dir, { recursive: true })
  app.quit()
})
