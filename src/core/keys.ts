// Keys as the browser tools name them ("Enter", "a", "cmd+shift+z", "Page_Down"),
// turned into what a Chrome DevTools Protocol key event needs.

export interface KeyPress {
  /** The DOM key value, e.g. "a" or "Enter". */
  key: string
  /** The DOM code, e.g. "KeyA". */
  code: string
  /** The Windows virtual key code Chromium also wants. */
  keyCode: number
  /** What the key types; empty when it types nothing. */
  text: string
  /** Alt 1, Ctrl 2, Meta 4, Shift 8, as the protocol counts them. */
  modifiers: number
  /** Editing commands macOS binds to the shortcut, which a synthetic key event does not trigger by itself. */
  commands: string[]
}

export const ALT = 1
export const CTRL = 2
export const META = 4
export const SHIFT = 8

const MODIFIERS: Record<string, number> = {
  alt: ALT,
  option: ALT,
  opt: ALT,
  ctrl: CTRL,
  control: CTRL,
  cmd: META,
  command: META,
  meta: META,
  super: META,
  win: META,
  windows: META,
  shift: SHIFT,
}

interface Named {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED: Record<string, Named> = {}
function name(names: string[], key: string, code: string, keyCode: number, text?: string): void {
  for (const n of names) NAMED[n.toLowerCase()] = { key, code, keyCode, text }
}
name(['Enter', 'Return', 'KP_Enter'], 'Enter', 'Enter', 13, '\r')
name(['Tab'], 'Tab', 'Tab', 9, '\t')
name(['Backspace', 'BackSpace'], 'Backspace', 'Backspace', 8)
name(['Delete', 'Del'], 'Delete', 'Delete', 46)
name(['Escape', 'Esc'], 'Escape', 'Escape', 27)
name(['Space', 'space'], ' ', 'Space', 32, ' ')
name(['ArrowUp', 'Up'], 'ArrowUp', 'ArrowUp', 38)
name(['ArrowDown', 'Down'], 'ArrowDown', 'ArrowDown', 40)
name(['ArrowLeft', 'Left'], 'ArrowLeft', 'ArrowLeft', 37)
name(['ArrowRight', 'Right'], 'ArrowRight', 'ArrowRight', 39)
name(['Home'], 'Home', 'Home', 36)
name(['End'], 'End', 'End', 35)
name(['PageUp', 'Page_Up', 'Prior'], 'PageUp', 'PageUp', 33)
name(['PageDown', 'Page_Down', 'Next'], 'PageDown', 'PageDown', 34)
name(['Insert'], 'Insert', 'Insert', 45)
for (let i = 1; i <= 12; i++) name([`F${i}`], `F${i}`, `F${i}`, 111 + i)

/** Characters on keys other than letters and digits: [code, key code, shifted character]. */
const PUNCTUATION: Record<string, [string, number, string]> = {
  '-': ['Minus', 189, '_'],
  '=': ['Equal', 187, '+'],
  '[': ['BracketLeft', 219, '{'],
  ']': ['BracketRight', 221, '}'],
  '\\': ['Backslash', 220, '|'],
  ';': ['Semicolon', 186, ':'],
  "'": ['Quote', 222, '"'],
  ',': ['Comma', 188, '<'],
  '.': ['Period', 190, '>'],
  '/': ['Slash', 191, '?'],
  '`': ['Backquote', 192, '~'],
}
const DIGIT_SHIFTED = ')!@#$%^&*('

const COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' }

/** Modifier names joined by "+", e.g. "cmd+shift". */
export function parseModifiers(text: string | undefined): number {
  let modifiers = 0
  for (const part of (text ?? '').split('+')) {
    const name = part.trim().toLowerCase()
    if (!name) continue
    const bit = MODIFIERS[name]
    if (bit === undefined) throw new Error(`Unknown modifier "${part.trim()}"`)
    modifiers |= bit
  }
  return modifiers
}

/** One key or shortcut, e.g. "Enter", "a", "A", "cmd+a" or "ctrl+shift+Tab". */
export function parseKey(spec: string): KeyPress {
  // "+" alone, or as the last part of a shortcut ("cmd++"), is the plus key.
  const parts = spec === '+' ? ['+'] : spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+')
  const keyName = parts.pop() ?? ''
  const modifiers = parseModifiers(parts.join('+'))
  const press = keyOf(keyName, modifiers)
  if (!press) throw new Error(`Unknown key "${keyName}"`)
  return press
}

/** Space-separated keys, e.g. "Backspace Backspace Delete". */
export function parseKeys(text: string): KeyPress[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((spec) => parseKey(spec))
}

/** The key that types a character, for the user's typing in the browser pane. */
export function keyOf(keyName: string, modifiers: number): KeyPress | null {
  const typing = (modifiers & (CTRL | META | ALT)) === 0
  const named = NAMED[keyName.toLowerCase()]
  if (named && (keyName.length > 1 || keyName === ' ')) {
    return { key: named.key, code: named.code, keyCode: named.keyCode, text: typing ? (named.text ?? '') : '', modifiers, commands: [] }
  }
  if ([...keyName].length !== 1) return null
  const shift = (modifiers & SHIFT) !== 0
  const commands = (modifiers & META) !== 0 && (modifiers & (CTRL | ALT)) === 0 ? commandsOf(keyName.toLowerCase(), shift) : []
  if (/^[a-z]$/i.test(keyName)) {
    // An uppercase letter is typed with Shift.
    const upper = shift || keyName !== keyName.toLowerCase()
    const key = upper ? keyName.toUpperCase() : keyName.toLowerCase()
    return { key, code: `Key${keyName.toUpperCase()}`, keyCode: keyName.toUpperCase().charCodeAt(0), text: typing ? key : '', modifiers: upper && keyName !== keyName.toLowerCase() ? modifiers | SHIFT : modifiers, commands }
  }
  if (/^[0-9]$/.test(keyName)) {
    const key = shift ? (DIGIT_SHIFTED[Number(keyName)] ?? keyName) : keyName
    return { key, code: `Digit${keyName}`, keyCode: 48 + Number(keyName), text: typing ? key : '', modifiers, commands }
  }
  const punct = PUNCTUATION[keyName]
  if (punct) {
    const key = shift ? punct[2] : keyName
    return { key, code: punct[0], keyCode: punct[1], text: typing ? key : '', modifiers, commands }
  }
  for (const [code, keyCode, shifted] of Object.values(PUNCTUATION)) {
    if (shifted === keyName) return { key: keyName, code, keyCode, text: typing ? keyName : '', modifiers: modifiers | SHIFT, commands }
  }
  const digit = DIGIT_SHIFTED.indexOf(keyName)
  if (digit !== -1) return { key: keyName, code: `Digit${digit}`, keyCode: 48 + digit, text: typing ? keyName : '', modifiers: modifiers | SHIFT, commands }
  // Any other character: typed, with no key of its own.
  return { key: keyName, code: '', keyCode: 0, text: typing ? keyName : '', modifiers, commands }
}

function commandsOf(letter: string, shift: boolean): string[] {
  if (letter === 'z') return [shift ? 'redo' : 'undo']
  const command = COMMANDS[letter]
  return command && !shift ? [command] : []
}
