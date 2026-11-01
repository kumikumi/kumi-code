// Which of Claude Code's model rows a conversation's model is. Claude Code lists a
// "Default" row that stands for one of the other rows; the menu shows that row
// instead, so it names the model.

import type { ModelOption } from './types'

/** The value of Claude Code's Default row. */
const DEFAULT_ROW = 'default'

/** The rows the model menu offers: the Default row only when no other row is its model. */
export function modelChoices(models: ModelOption[]): ModelOption[] {
  const fallback = models.find((m) => m.value === DEFAULT_ROW)
  if (!fallback || !models.some((m) => m !== fallback && m.resolvedModel === fallback.resolvedModel)) return models
  return models.filter((m) => m !== fallback)
}

/**
 * The menu row of a conversation's model, null being Claude Code's default;
 * undefined when the list does not offer it (or has not arrived).
 */
export function modelRow(models: ModelOption[], model: string | null): ModelOption | undefined {
  const wanted = model ?? models.find((m) => m.value === DEFAULT_ROW)?.resolvedModel
  const choices = modelChoices(models)
  return choices.find((m) => m.value === wanted) ?? choices.find((m) => m.resolvedModel === wanted)
}
