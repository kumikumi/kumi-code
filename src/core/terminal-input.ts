// What send_to_terminal sends: its steps (text typed as given, keys pressed, waits
// for output), checked before anything is sent, and keys as it names them ("Enter",
// "Down", "ctrl+c", "shift+Tab", "F5") turned into the bytes a terminal sends for
// them. Cursor keys depend on a mode the program sets (application cursor keys,
// which editors, pagers and menus turn on), so the caller says which mode is on.

import { ALT, CTRL, META, parseModifiers, SHIFT } from './keys'

const ESC = '\x1b'
/** The longest wait step. */
export const MAX_WAIT_MS = 60_000

export type InputStep = { kind: 'text'; text: string } | { kind: 'keys'; keys: string } | { kind: 'wait'; ms: number }

/** Keys whose sequence takes modifiers as `ESC [ 1 ; m <final>`, and their final byte. */
const CURSOR: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
/** Keys sent as `ESC [ <n> ~`, and their number. */
const TILDE: Record<string, number> = { insert: 2, delete: 3, pageup: 5, pagedown: 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 }
/** F1–F4: `ESC O <final>`, or `ESC [ 1 ; m <final>` with modifiers. */
const PF: Record<string, string> = { f1: 'P', f2: 'Q', f3: 'R', f4: 'S' }

const ALIASES: Record<string, string> = {
  return: 'enter',
  kp_enter: 'enter',
  esc: 'escape',
  del: 'delete',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  page_up: 'pageup',
  prior: 'pageup',
  page_down: 'pagedown',
  next: 'pagedown',
}

/** send_to_terminal's input, checked: every step holds one of text, keys or wait_for_output_ms, and every key name is known. */
export function inputSteps(input: unknown): InputStep[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('input needs at least one step.')
  return input.map((raw: unknown, i): InputStep => {
    const step = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const given = ['text', 'keys', 'wait_for_output_ms'].filter((k) => step[k] !== undefined)
    if (given.length !== 1) throw new Error(`Step ${i + 1} needs exactly one of text, keys or wait_for_output_ms.`)
    const { text, keys, wait_for_output_ms: ms } = step
    if (given[0] === 'text') {
      if (typeof text !== 'string' || !text) throw new Error(`Step ${i + 1}: text must be a non-empty string.`)
      // C0 and C1 controls, DEL included.
      if (/[\x00-\x1f\x7f-\x9f]/.test(text)) throw new Error(`Step ${i + 1}: text may not hold control characters such as newlines, tabs or escapes; press those as keys ("Enter", "Tab", "Escape").`)
      return { kind: 'text', text }
    }
    if (given[0] === 'keys') {
      if (typeof keys !== 'string') throw new Error(`Step ${i + 1}: keys must be a string of key names.`)
      try {
        terminalKeys(keys, false)
      } catch (err) {
        throw new Error(`Step ${i + 1}, ${JSON.stringify(keys)}: ${err instanceof Error ? err.message : String(err)}.`)
      }
      return { kind: 'keys', keys }
    }
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error(`Step ${i + 1}: wait_for_output_ms must be a number of milliseconds.`)
    return { kind: 'wait', ms: Math.min(ms, MAX_WAIT_MS) }
  })
}

/** The bytes of each of space-separated keys, e.g. "Down Down Enter" or "ctrl+c". */
export function terminalKeys(spec: string, applicationCursor: boolean): string[] {
  const keys = spec.trim().split(/\s+/).filter(Boolean)
  if (keys.length === 0) throw new Error('No keys given')
  return keys.map((key) => terminalKey(key, applicationCursor))
}

/** One key, with modifiers joined by "+", e.g. "ctrl+shift+Up". */
export function terminalKey(spec: string, applicationCursor: boolean): string {
  // "+" alone, or as the last part ("ctrl++"), is the plus key.
  const parts = spec === '+' ? ['+'] : spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+')
  const name = parts.pop() ?? ''
  const modifiers = parseModifiers(parts.join('+'))
  if (modifiers & META) throw new Error(`"${spec}": cmd shortcuts belong to the app, not to programs in the terminal`)
  const lower = name.toLowerCase()
  const key = ALIASES[lower] ?? lower
  // xterm's modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4.
  const param = 1 + (modifiers & SHIFT ? 1 : 0) + (modifiers & ALT ? 2 : 0) + (modifiers & CTRL ? 4 : 0)
  const alt = (bytes: string): string => (modifiers & ALT ? ESC + bytes : bytes)

  if (key in CURSOR) {
    const final = CURSOR[key] ?? ''
    if (param > 1) return `${ESC}[1;${param}${final}`
    return applicationCursor ? `${ESC}O${final}` : `${ESC}[${final}`
  }
  if (key in TILDE) return param > 1 ? `${ESC}[${TILDE[key]};${param}~` : `${ESC}[${TILDE[key]}~`
  if (key in PF) return param > 1 ? `${ESC}[1;${param}${PF[key]}` : `${ESC}O${PF[key]}`
  switch (key) {
    case 'enter':
      return alt('\r')
    case 'tab':
      return modifiers & SHIFT ? `${ESC}[Z` : alt('\t')
    case 'escape':
      return alt(ESC)
    case 'backspace':
      return alt(modifiers & CTRL ? '\x08' : '\x7f')
    case 'space':
      return modifiers & CTRL ? '\x00' : alt(' ')
  }
  if ([...name].length !== 1) throw new Error(`Unknown key "${name}"`)
  if (modifiers & CTRL) {
    const control = controlCharacter(name)
    if (control === null) throw new Error(`"${spec}" has no control character`)
    return alt(control)
  }
  return alt(modifiers & SHIFT ? name.toUpperCase() : name)
}

/** The control character Ctrl and a key send: ctrl+c is 0x03, ctrl+[ is ESC. */
function controlCharacter(key: string): string | null {
  const code = key.toUpperCase().charCodeAt(0)
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40)
  if (key === '?') return '\x7f'
  if (key === ' ' || key === '2') return '\x00'
  return null
}
