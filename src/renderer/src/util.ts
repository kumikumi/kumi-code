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

function startOfDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Calendar days, so a daylight saving change does not shift the boundary. */
function addDays(dayStart: number, days: number): number {
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
