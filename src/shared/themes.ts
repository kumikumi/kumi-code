// The color themes a conversation can pick, so that conversations are easy to tell
// apart. Their colors are in the renderer's styles.css, under [data-theme].

/** In the picker's order: around the color wheel from the default, then the neutral one. */
export const THEMES = [
  { id: 'kumi', name: 'Kumi' },
  { id: 'anuja', name: 'Anuja' },
  { id: 'pine', name: 'Pine' },
  { id: 'moss', name: 'Moss' },
  { id: 'ember', name: 'Ember' },
  { id: 'rose', name: 'Rose' },
  { id: 'plum', name: 'Plum' },
  { id: 'graphite', name: 'Graphite' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

/** The app icon's colors: dark blue with the rubber duck's yellow. */
export const DEFAULT_THEME: ThemeId = 'kumi'

export function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value)
}

/** A theme at random, any but `except` (null: any at all). `random` returns [0, 1), as Math.random. */
export function randomTheme(except: ThemeId | null, random: () => number = Math.random): ThemeId {
  const choices = THEMES.filter((t) => t.id !== except)
  const choice = choices[Math.floor(random() * choices.length)]
  if (!choice) throw new Error(`random() returned a number outside [0, 1)`)
  return choice.id
}
