// The next-step box: what an agent's wrap_up call says, as the main process and
// the renderer read it.

/** The Claude desktop app's name for it. */
export const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

/** A reply button: its label, and the message a click sends as the user's. */
export interface WrapUpReply {
  label: string
  message: string
}

export interface WrapUp {
  recap: string
  ask: string | null
  replies: WrapUpReply[]
  /** App actions the agent asked for, which Kumi Code does not have. */
  appActions: string[]
  blocked: boolean
}

export function parseWrapUp(input: Record<string, unknown>): WrapUp {
  const actions = Array.isArray(input.actions) ? (input.actions as Record<string, unknown>[]) : []
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    recap: text(input.recap),
    ask: text(input.ask) || null,
    replies: actions.filter((a) => !text(a.action) && text(a.label)).map((a) => ({ label: text(a.label), message: text(a.message) || text(a.label) })),
    appActions: actions.map((a) => text(a.action)).filter(Boolean),
    blocked: input.blocked === true,
  }
}
