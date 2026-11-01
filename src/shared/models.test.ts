import { describe, expect, it } from 'vitest'
import { modelChoices, modelRow } from './models'
import type { ModelOption } from './types'

function row(value: string, resolvedModel: string): ModelOption {
  return { value, resolvedModel, displayName: value, description: '', efforts: [], supportsAutoMode: false }
}

const models = [row('default', 'claude-opus-5-5'), row('opus', 'claude-opus-5-5'), row('sonnet', 'claude-sonnet-5-5'), row('claude-opus-4-8', 'claude-opus-4-8')]

describe('modelChoices', () => {
  it('leaves out the Default row when another row is its model', () => {
    expect(modelChoices(models).map((m) => m.value)).toEqual(['opus', 'sonnet', 'claude-opus-4-8'])
  })

  it('keeps the Default row when it is the only row for its model', () => {
    const own = [row('default', 'claude-fable-5-1'), row('sonnet', 'claude-sonnet-5-5')]
    expect(modelChoices(own)).toEqual(own)
  })
})

describe('modelRow', () => {
  it('shows the default model as the row it stands for', () => {
    expect(modelRow(models, null)?.value).toBe('opus')
  })

  it('finds a row by its value or by the model it resolves to', () => {
    expect(modelRow(models, 'sonnet')?.value).toBe('sonnet')
    expect(modelRow(models, 'claude-sonnet-5-5')?.value).toBe('sonnet')
  })

  it('finds no row for a model the list no longer offers, or before the list arrives', () => {
    expect(modelRow(models, 'claude-opus-4-6')).toBeUndefined()
    expect(modelRow([], null)).toBeUndefined()
  })
})
