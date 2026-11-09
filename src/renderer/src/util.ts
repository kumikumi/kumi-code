export interface DateGroup<T> {
  label: string
  items: T[]
}

/**
 * Groups items, newest first, by when they happened: Today, Yesterday, Previous
 * 7 days, Previous 30 days, then by month. Days are local calendar days.
 */
export function groupByDate<T>(items: T[], timeOf: (item: T) => number, now = Date.now()): DateGroup<T>[] {
  const today = startOfDay(now)
  const yesterday = addDays(today, -1)
  const week = addDays(today, -7)
  const month = addDays(today, -30)
  const thisYear = new Date(now).getFullYear()
  const groups: DateGroup<T>[] = []
  for (const item of items) {
    const ts = timeOf(item)
    let label: string
    if (ts >= today) label = 'Today'
    else if (ts >= yesterday) label = 'Yesterday'
    else if (ts >= week) label = 'Previous 7 days'
    else if (ts >= month) label = 'Previous 30 days'
    else {
      const date = new Date(ts)
      label = date.toLocaleDateString(undefined, { month: 'long', year: date.getFullYear() === thisYear ? undefined : 'numeric' })
    }
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** A time as precisely as its date group needs: the clock time this week, the date before. */
export function shortTime(ts: number, now = Date.now()): string {
  const today = startOfDay(now)
  const date = new Date(ts)
  if (ts >= addDays(today, -1)) return clockTime(ts)
  if (ts >= addDays(today, -7)) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clockTime(ts)}`
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })
}

/**
 * When a message was sent or a reply finished, for the transcript: the clock time today,
 * with "Yesterday" or the weekday this week, the date before (and the year when it is not this one).
 */
export function messageTime(ts: number, now = Date.now()): string {
  const today = startOfDay(now)
  const date = new Date(ts)
  if (ts >= today) return clockTime(ts)
  if (ts >= addDays(today, -1)) return `Yesterday ${clockTime(ts)}`
  if (ts >= addDays(today, -6)) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clockTime(ts)}`
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })}, ${clockTime(ts)}`
}

/** A time in full, to the second, for a tooltip. */
export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' })
}

/** How long ago something was, as GitLens says it: "just now", "3 minutes ago", "yesterday", "2 months ago". */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.floor((now - ts) / 1000)
  const ago = (n: number, unit: string, one: string): string => (n === 1 ? one : `${n} ${unit}s ago`)
  if (s < 10) return 'just now'
  if (s < 60) return `${s} seconds ago`
  if (s < 3600) return ago(Math.floor(s / 60), 'minute', 'a minute ago')
  if (s < 86400) return ago(Math.floor(s / 3600), 'hour', 'an hour ago')
  const days = Math.floor(s / 86400)
  if (days < 30) return ago(days, 'day', 'yesterday')
  if (days < 365) return ago(Math.max(1, Math.round(days / 30)), 'month', 'last month')
  return ago(Math.floor(days / 365), 'year', 'last year')
}

/** How long something took, in whole seconds: "<1s", "42s", "3m 5s", "1h 12m". */
export function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** A byte count as Finder shows it, in powers of 1000: "512 B", "3.4 kB", "12 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** The start of the local calendar day `ts` is in. */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Calendar days, so a daylight saving change does not shift the boundary. */
export function addDays(dayStart: number, days: number): number {
  const d = new Date(dayStart)
  d.setDate(d.getDate() + days)
  return d.getTime()
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
