// Makes the development Electron app Kumi Code in the Dock, the menu bar and the app switcher.
// The Dock titles a running app after its bundle's folder name, so the bundle is renamed, and
// path.txt, which both `electron` and electron-vite read to find the executable, follows it.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

if (process.platform === 'darwin') {
  const root = resolve(import.meta.dirname, '..')
  const electron = join(root, 'node_modules/electron')
  const bundle = join(electron, 'dist/Kumi Code.app')
  // Installing Electron extracts a fresh Electron.app, next to the bundle renamed from the last one.
  if (existsSync(join(electron, 'dist/Electron.app'))) {
    rmSync(bundle, { recursive: true, force: true })
    renameSync(join(electron, 'dist/Electron.app'), bundle)
  }
  const plist = join(bundle, 'Contents/Info.plist')
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('plutil', ['-replace', key, '-string', 'Kumi Code', plist])
  }
  copyFileSync(join(root, 'resources/icon.icns'), join(bundle, 'Contents/Resources/electron.icns'))
  writeFileSync(join(electron, 'path.txt'), 'Kumi Code.app/Contents/MacOS/Electron')
  // The Dock keeps showing a bundle's old icon until the bundle's modification time changes.
  const now = new Date()
  utimesSync(bundle, now, now)
}
