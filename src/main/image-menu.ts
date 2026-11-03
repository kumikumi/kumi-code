// The menu of an image in the transcript: copy it, save it, or show the file it was read from.

import { app, clipboard, ClipboardItem, dialog, Menu, nativeImage, shell } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import type { ImageData, ImageMenuTarget } from '@shared/types'

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function popupImageMenu(win: BrowserWindow, { image, png, path }: ImageMenuTarget): void {
  const items: MenuItemConstructorOptions[] = [
    { label: 'Copy Image', click: () => void copy(png ?? image.data) },
    { label: 'Save Image As…', click: () => void save(win, image, path) },
  ]
  // A file read earlier may be gone, such as a screenshot in /tmp.
  if (path && existsSync(path)) items.push({ type: 'separator' }, { label: 'Show in Finder', click: () => shell.showItemInFolder(path) })
  Menu.buildFromTemplate(items).popup({ window: win })
}

/** Puts a base64 PNG or JPEG on the clipboard, as PNG, the image format every app pastes. */
async function copy(data: string): Promise<void> {
  const png = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toPNG()
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

/** Saves the image as the transcript has it, which for a file read may be smaller than the file. */
async function save(win: BrowserWindow, image: ImageData, path: string | null): Promise<void> {
  const ext = EXTENSIONS[image.mediaType] ?? image.mediaType.split('/')[1] ?? 'png'
  const name = `${path ? parse(path).name : 'image'}.${ext}`
  const res = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), name) })
  if (res.canceled || !res.filePath) return
  await writeFile(res.filePath, Buffer.from(image.data, 'base64')).catch((err: unknown) =>
    dialog.showErrorBox('Could not save the image', err instanceof Error ? err.message : String(err)),
  )
}
