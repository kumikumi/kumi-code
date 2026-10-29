import { describe, expect, it } from 'vitest'
import { groupByDate } from './util'

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
