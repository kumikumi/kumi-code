import { describe, expect, it } from 'vitest'
import { ALT, CTRL, META, SHIFT, keyOf, parseKey, parseKeys, parseModifiers, userKey } from './keys'

describe('keys', () => {
  it('names keys the way the browser tools do', () => {
    expect(parseKey('Enter')).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
    expect(parseKey('Return')).toMatchObject({ key: 'Enter' })
    expect(parseKey('Page_Down')).toMatchObject({ key: 'PageDown', keyCode: 34, text: '' })
    expect(parseKey('a')).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: 0 })
    expect(parseKey('A')).toMatchObject({ key: 'A', code: 'KeyA', text: 'A', modifiers: SHIFT })
    expect(parseKey('?')).toMatchObject({ key: '?', code: 'Slash', modifiers: SHIFT })
    expect(parseKeys('Backspace Backspace Delete').map((k) => k.key)).toEqual(['Backspace', 'Backspace', 'Delete'])
  })

  it('turns macOS shortcuts into the editing commands a synthetic event lacks', () => {
    expect(parseKey('cmd+a')).toMatchObject({ key: 'a', text: '', modifiers: META, commands: ['selectAll'] })
    expect(parseKey('cmd+shift+z')).toMatchObject({ modifiers: META | SHIFT, commands: ['redo'] })
    expect(parseKey('ctrl+a').commands).toEqual([])
    expect(parseKey('cmd++')).toMatchObject({ key: '+', modifiers: META | SHIFT })
  })

  it("passes the user's keys on as their layout types them", () => {
    // A Finnish Mac: Option+2 is "@", Shift+7 is "/", Shift+0 is "=".
    expect(userKey('@', 'Digit2', 50, ALT)).toMatchObject({ key: '@', code: 'Digit2', text: '@', modifiers: ALT })
    expect(userKey('/', 'Digit7', 55, SHIFT)).toMatchObject({ key: '/', text: '/', modifiers: SHIFT })
    expect(userKey('=', 'Digit0', 48, SHIFT)).toMatchObject({ text: '=' })
    // AltGr on Windows and Linux is Ctrl+Alt.
    expect(userKey('@', 'Digit2', 50, CTRL | ALT).text).toBe('@')
    expect(userKey('Enter', 'Enter', 13, 0).text).toBe('\r')
    expect(userKey('Meta', 'MetaLeft', 91, META)).toMatchObject({ text: '', commands: [] })
    expect(userKey('v', 'KeyV', 86, META)).toMatchObject({ text: '', commands: ['paste'] })
    expect(userKey('a', 'KeyA', 65, CTRL).text).toBe('')
  })

  it('rejects what it does not know', () => {
    expect(() => parseKey('hyper+a')).toThrow('Unknown modifier')
    expect(() => parseKey('NoSuchKey')).toThrow('Unknown key')
    expect(parseModifiers('ctrl+shift')).toBe(2 | SHIFT)
    expect(keyOf('é', 0)).toMatchObject({ key: 'é', text: 'é' })
  })
})
