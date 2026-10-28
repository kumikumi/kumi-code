export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} d ago`
  return new Date(ts).toLocaleDateString()
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** `path` relative to `cwd` when it is inside it; otherwise with the home folder shortened. */
export function displayPath(path: string, cwd: string): string {
  // macOS reports /var and /tmp also as /private/var and /private/tmp.
  for (const dir of [cwd, `/private${cwd}`]) if (path.startsWith(`${dir}/`)) return path.slice(dir.length + 1)
  return tildify(path)
}

export function tildify(path: string): string {
  const home = /^\/Users\/[^/]+/.exec(path)?.[0]
  return home ? `~${path.slice(home.length)}` : path
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

/** An error from the main process, without Electron's IPC wrapping. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
}
