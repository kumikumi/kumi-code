// What the wrap_up tool tells the agent: whether Kumi Code shows the next-step
// box, what it could not show, and advice for the next call.

import { APP_ACTIONS, parseWrapUp } from '@shared/wrap-up'

/** `available`: the app actions that hold now. */
export function wrapUpResult(input: Record<string, unknown>, available: string[]): { text: string; isError: boolean } {
  const w = parseWrapUp(input)
  const refuse = (text: string): { text: string; isError: boolean } => ({ text: `Not shown: ${text}`, isError: true })
  if (!w.recap) return refuse('recap is required.')
  const unavailable = w.appActions.filter((a) => !available.includes(a))
  if (unavailable.length > 0) {
    const unknown = unavailable.filter((a) => !(a in APP_ACTIONS))
    const idle = unavailable.filter((a) => a in APP_ACTIONS)
    const parts = [
      unknown.length > 0 && `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an action' : 'are not actions'} the app has`,
      idle.length > 0 && `${idle.join(', ')} ${idle.length === 1 ? 'does' : 'do'} not hold right now`,
    ].filter(Boolean)
    const one = unavailable.length === 1
    return refuse(
      `${parts.join('; ')} (app actions available: ${available.join(', ') || 'none'}), so it could not draw ${one ? 'that button' : 'those buttons'} and would drop your question with ${one ? 'it' : 'them'}. Call wrap_up again with only available app actions, or say it as a reply ({"label": "…", "message": "…"}) — for something you can do yourself when clicked, the message asks you to.`,
    )
  }
  const count = Array.isArray(input.actions) ? input.actions.length : 0
  if (count > 2) return refuse(`${count} buttons; give 1–2, recommendation first.`)
  if (w.buttons.length > 0 && !w.ask) return refuse('buttons answer a question, and there is no ask. Call wrap_up again with the ask, or without actions.')
  const command = w.replies.find((r) => /^[/!]/.test(r.label) || /^[/!]/.test(r.message))
  if (command) return refuse(`the button "${command.label}" starts with / or !, which the app would run as a command when clicked. Call wrap_up again without the leading character.`)

  const advice: string[] = []
  if (w.recap.length > 300) advice.push(`recap is two or three sentences (about 300 characters); this one ran ${w.recap.length}.`)
  if (w.ask && w.ask.length > 100) advice.push(`ask is at most 100 characters; this one ran ${w.ask.length}.`)
  for (const r of w.replies) {
    if (r.label.length > 24) advice.push(`the label "${r.label}" runs ${r.label.length} characters; a label is 1–3 words, 24 characters at most.`)
    if (r.message.length > 300) advice.push(`the message of "${r.label}" runs ${r.message.length} characters; at most 300.`)
  }
  const shown = w.ask
    ? `Shown in the next-step box${w.buttons.length === 0 ? ', without buttons: the user answers in the message box' : ''}. Your closing message is your answer to the user: write it now, in full, as the last thing you say this turn. The box asks your question, so do not ask it again.`
    : 'Nothing is pending, so the app draws no box. Your closing message is your answer to the user: write it now, as the last thing you say this turn.'
  const next = advice.length > 0 ? ` Do not call wrap_up again this turn; this is for your next call: ${advice.join(' ')}` : ''
  return { text: shown + next, isError: false }
}
