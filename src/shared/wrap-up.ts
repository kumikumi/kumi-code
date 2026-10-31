// The next-step box: what an agent's wrap_up call says, as the main process and
// the renderer read it.

/** The Claude desktop app's name for it. */
export const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

/** A button of the box: its label, and the message a click sends as the user's. */
export interface WrapUpButton {
  label: string
  message: string
}

/** The app actions Kumi Code has: the button each draws, whose click asks the agent to do it. */
export const APP_ACTIONS: Record<string, WrapUpButton> = {
  commit: { label: 'Commit', message: 'Commit the changes.' },
}

export interface WrapUp {
  recap: string
  ask: string | null
  /** In the agent's order, the first the primary one: its replies, and the app actions Kumi Code has. */
  buttons: WrapUpButton[]
  replies: WrapUpButton[]
  /** Every app action the agent asked for, also those Kumi Code does not have. */
  appActions: string[]
  blocked: boolean
}

export function parseWrapUp(input: Record<string, unknown>): WrapUp {
  const actions = Array.isArray(input.actions) ? (input.actions as Record<string, unknown>[]) : []
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const w: WrapUp = { recap: text(input.recap), ask: text(input.ask) || null, buttons: [], replies: [], appActions: [], blocked: input.blocked === true }
  for (const a of actions) {
    const action = text(a.action)
    if (action) {
      w.appActions.push(action)
      const button = APP_ACTIONS[action]
      if (button) w.buttons.push(button)
    } else if (text(a.label)) {
      const reply = { label: text(a.label), message: text(a.message) || text(a.label) }
      w.replies.push(reply)
      w.buttons.push(reply)
    }
  }
  return w
}
