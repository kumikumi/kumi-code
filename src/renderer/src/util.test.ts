import { describe, expect, it } from 'vitest'
import { duration, fileSize, groupByDate, messageTime, relativeTime } from './util'

describe('fileSize', () => {
  it('reads like Finder', () => {
    expect(fileSize(0)).toBe('0 B')
    expect(fileSize(999)).toBe('999 B')
    expect(fileSize(3400)).toBe('3.4 kB')
    expect(fileSize(12_345_678)).toBe('12 MB')
    expect(fileSize(999_999)).toBe('1.0 MB')
    expect(fileSize(2_500_000_000)).toBe('2.5 GB')
  })
})

describe('groupByDate', () => {
  it('groups newest-first items by calendar day, week, month', () => {
    const now = new Date(2026, 9, 29, 9, 30).getTime()
    const at = (month: number, day: number, hour = 12): number => new Date(2026, month, day, hour).getTime()
    const items = [
      at(9, 29, 8), // today
      at(9, 28, 23), // yesterday, late
      at(9, 28, 0), // yesterday, just after midnight
      at(9, 24), // within 7 days
      at(9, 10), // within 30 days
      at(8, 20), // September
      at(8, 2),
      at(7, 15), // August
    ]
    const groups = groupByDate(items, (t) => t, now)
    expect(groups.map((g) => g.items.length)).toEqual([1, 2, 1, 1, 2, 1])
    expect(groups.slice(0, 4).map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days'])
    expect(groups[4]?.label).toBe(new Date(2026, 8, 20).toLocaleDateString(undefined, { month: 'long' }))
  })

  it('names the year of months from other years', () => {
    const now = new Date(2026, 0, 15).getTime()
    const [group] = groupByDate([new Date(2025, 10, 3).getTime()], (t) => t, now)
    expect(group?.label).toContain('2025')
  })
})

describe('messageTime', () => {
  const now = new Date(2026, 10, 1, 15, 30).getTime()
  const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  it('gives the clock time today and says which day before', () => {
    const today = new Date(2026, 10, 1, 9, 5).getTime()
    const yesterday = new Date(2026, 9, 31, 23, 50).getTime()
    const thisWeek = new Date(2026, 9, 27, 8, 0).getTime()
    expect(messageTime(today, now)).toBe(clock(today))
    expect(messageTime(yesterday, now)).toBe(`Yesterday ${clock(yesterday)}`)
    expect(messageTime(thisWeek, now)).toBe(`${new Date(thisWeek).toLocaleDateString(undefined, { weekday: 'short' })} ${clock(thisWeek)}`)
  })

  it('gives the date before this week, with the year when it is not this one', () => {
    const earlier = new Date(2026, 9, 2, 10, 0).getTime()
    const lastYear = new Date(2025, 11, 30, 10, 0).getTime()
    expect(messageTime(earlier, now)).toBe(`${new Date(earlier).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${clock(earlier)}`)
    expect(messageTime(lastYear, now)).toContain('2025')
  })
})

describe('duration', () => {
  it('counts whole seconds, then minutes, then hours', () => {
    expect(duration(400)).toBe('<1s')
    expect(duration(42_900)).toBe('42s')
    expect(duration(185_000)).toBe('3m 5s')
    expect(duration(4_330_000)).toBe('1h 12m')
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 10, 6, 12)
  it('says how long ago, in the largest whole unit', () => {
    expect(relativeTime(now - 3000, now)).toBe('just now')
    expect(relativeTime(now - 42_000, now)).toBe('42 seconds ago')
    expect(relativeTime(now - 60_000, now)).toBe('a minute ago')
    expect(relativeTime(now - 5 * 3600_000, now)).toBe('5 hours ago')
    expect(relativeTime(now - 30 * 3600_000, now)).toBe('yesterday')
    expect(relativeTime(now - 9 * 86400_000, now)).toBe('9 days ago')
    expect(relativeTime(now - 75 * 86400_000, now)).toBe('3 months ago')
    expect(relativeTime(now - 800 * 86400_000, now)).toBe('2 years ago')
  })
})
