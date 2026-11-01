import { describe, expect, it } from 'vitest'
import { inputSteps, terminalKey, terminalKeys } from './terminal-input'

describe('terminal keys', () => {
  it('sends what a terminal sends for named keys', () => {
    expect(terminalKey('Enter', false)).toBe('\r')
    expect(terminalKey('Return', false)).toBe('\r')
    expect(terminalKey('Escape', false)).toBe('\x1b')
    expect(terminalKey('Tab', false)).toBe('\t')
    expect(terminalKey('shift+Tab', false)).toBe('\x1b[Z')
    expect(terminalKey('Backspace', false)).toBe('\x7f')
    expect(terminalKey('Space', false)).toBe(' ')
    expect(terminalKey('PageDown', false)).toBe('\x1b[6~')
    expect(terminalKey('Delete', false)).toBe('\x1b[3~')
    expect(terminalKey('F1', false)).toBe('\x1bOP')
    expect(terminalKey('F5', false)).toBe('\x1b[15~')
  })

  it('sends cursor keys in the mode the program asked for', () => {
    expect(terminalKey('Down', false)).toBe('\x1b[B')
    expect(terminalKey('Down', true)).toBe('\x1bOB')
    expect(terminalKey('ArrowLeft', true)).toBe('\x1bOD')
    expect(terminalKey('Home', false)).toBe('\x1b[H')
    // With modifiers the mode does not matter.
    expect(terminalKey('ctrl+Up', true)).toBe('\x1b[1;5A')
    expect(terminalKey('shift+F5', false)).toBe('\x1b[15;2~')
    expect(terminalKey('alt+F1', false)).toBe('\x1b[1;3P')
  })

  it('sends control characters and Alt as Escape', () => {
    expect(terminalKey('ctrl+c', false)).toBe('\x03')
    expect(terminalKey('ctrl+D', false)).toBe('\x04')
    expect(terminalKey('ctrl+[', false)).toBe('\x1b')
    expect(terminalKey('alt+b', false)).toBe('\x1bb')
    expect(terminalKey('ctrl+alt+c', false)).toBe('\x1b\x03')
    expect(terminalKey('a', false)).toBe('a')
    expect(terminalKey('shift+a', false)).toBe('A')
    expect(terminalKey('+', false)).toBe('+')
  })

  it('sends each of several keys', () => {
    expect(terminalKeys('Down Down Enter', true)).toEqual(['\x1bOB', '\x1bOB', '\r'])
    expect(terminalKeys('  q  ', false)).toEqual(['q'])
  })

  it('rejects what it does not know', () => {
    expect(() => terminalKey('NoSuchKey', false)).toThrow('Unknown key "NoSuchKey"')
    expect(() => terminalKey('hyper+a', false)).toThrow('Unknown modifier')
    expect(() => terminalKey('cmd+c', false)).toThrow('cmd shortcuts')
    expect(() => terminalKey('ctrl+é', false)).toThrow('no control character')
    expect(() => terminalKeys(' ', false)).toThrow('No keys given')
  })
})

describe('send_to_terminal input', () => {
  it('takes text, keys and waits in order', () => {
    expect(inputSteps([{ text: 'deploy' }, { keys: 'Enter' }, { wait_for_output_ms: 2000 }, { keys: 'Down Down Enter' }, { text: 'v1.2.3 ü' }])).toEqual([
      { kind: 'text', text: 'deploy' },
      { kind: 'keys', keys: 'Enter' },
      { kind: 'wait', ms: 2000 },
      { kind: 'keys', keys: 'Down Down Enter' },
      { kind: 'text', text: 'v1.2.3 ü' },
    ])
    expect(inputSteps([{ wait_for_output_ms: 999_999 }])).toEqual([{ kind: 'wait', ms: 60_000 }])
  })

  it('checks every step before anything is sent', () => {
    expect(() => inputSteps([])).toThrow('at least one step')
    expect(() => inputSteps([{ text: 'a', keys: 'Enter' }])).toThrow('Step 1 needs exactly one')
    expect(() => inputSteps([{}])).toThrow('Step 1 needs exactly one')
    expect(() => inputSteps([{ text: 'ok' }, { keys: 'Down Dwn' }])).toThrow('Step 2, "Down Dwn": Unknown key "Dwn"')
    expect(() => inputSteps([{ text: 'ls\n' }])).toThrow('press those as keys')
    expect(() => inputSteps([{ text: '\x1b[A' }])).toThrow('control characters')
    expect(() => inputSteps([{ text: '' }])).toThrow('non-empty')
    expect(() => inputSteps([{ wait_for_output_ms: -1 }])).toThrow('milliseconds')
  })
})
