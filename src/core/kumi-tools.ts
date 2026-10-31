// Kumi Code's own tools, in-process MCP servers that every conversation gets.
// wrap_up fills the next-step box at the end of a turn; it is the Claude desktop
// app's tool, with its name (served by ccd_turn, so the agent sees
// mcp__ccd_turn__wrap_up), its schema and its description. In a code review, the implementer answers a finding Kumi Code relayed
// and the reviewer gives its verdict on the answer; those tools answer only in
// the role the conversation has; they are served by review. What the agent reads
// never names Kumi Code, which would read as one more party in the work. All are always
// loaded, so an agent has their schemas without a tool search. The servers stay the
// same while a process runs: Claude Code keeps a server it already has by its name.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ReviewAnswer } from './review'

/** Allowed without asking: all they do is record an answer, or show a box, in Kumi Code. */
export const KUMI_TOOLS = ['mcp__ccd_turn__wrap_up', 'mcp__review__respond_to_finding', 'mcp__review__resolve_finding']

/** Appended to Claude Code's system prompt: when to call wrap_up, as the desktop app tells its agents. */
export const KUMI_INSTRUCTIONS = `# Next step
Every turn in which you changed files, ran commands or completed multi-step work closes with mcp__ccd_turn__wrap_up, called when the turn's work is done and before your closing message: it fills the next-step box, and without the call the app has nothing to draw. The recap says in two or three sentences what is now true and where it stands, including what is not done or not verified. When the turn leaves the user a decision to make or a step to take, add one short question (the decision alone, no reason or recommendation) and one or two buttons that answer it, your pick first: replies, or the app's one action, {"action": "commit"}, which holds while the project is a git repository with uncommitted changes; with nothing pending, send the recap alone and no box is drawn. Your closing message follows the call, the last thing you say: your answer to the user in full, which the recap never replaces. Skip the call for short answers and pure conversation.`

export interface KumiToolHandlers {
  /** A review answer; returns what the tool tells the agent, or throws it as an error. */
  answer(a: ReviewAnswer): string
  wrapUp(input: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
}

// The desktop app's description, without its sentence about update_plan, a tool Kumi Code does not have.
const WRAP_UP_DESCRIPTION =
  'Fill the "next step" box the app shows at the end of your turn: a two-or-three-sentence recap and, when this turn leaves the user a decision to make or a step to take, one question and buttons that answer it; a turn with nothing pending ends with the recap alone, and the app then draws no box. Call it once in EVERY turn in which you kept a task list, changed files, ran commands, or completed multi-step work: when this turn\'s work is done, before any closing message. Skip it for short answers, pure conversation, or a brief read-and-explain turn — a reply that names a follow-up is not brief: ask or propose it, and call this.\n\nYour closing message is ordinary text right after this call, the last thing you say this turn: your answer to the user in full, which the recap never replaces. Never write it before this call, where it can reach the user cut to a short summary. The result says whether the box shows your question: ask in the message only a question it does not show.\n\nFields — recap and ask are said to the user, in the second person; a reply button\'s label and message are the user\'s words back to you:\n- recap: what is now true or changed, then where it stands, including what is not done or not verified (for example: nothing committed, or not checked in the app). Two or three short sentences, about 40 words / 300 characters, in the project\'s own words. No recommendation here.\n- ask (with actions, only when the next move is the user\'s call — a choice of approach, a go-ahead to fix, commit, push, post or send, an approval): just that ONE decision in one short sentence, never two joined by "and" ("Which fix first?"), with no reason or recommendation and without listing the options the buttons give: your pick, actions[0], is drawn as the primary button. At most 100 characters.\nEvery field is a top-level parameter holding plain prose (actions: a JSON array); none contains markup or another field.'

const wrapUpShape = {
  actions: z
    .array(
      z.looseObject({
        action: z
          .enum(['commit', 'create_pr', 'merge', 'fix_ci', 'address_comments', 'resolve_conflicts', 'verify', 'archive', 'new_session'])
          .optional()
          .describe(
            "An app action update_plan's result listed as available now, or one your own work this turn made available; anything else is refused, and one that stops being available later is dropped (as actions[0], with your ask and the other answers), so do not guess. Omit for a reply.",
          ),
        label: z
          .string()
          .optional()
          .describe(
            'For a reply: the button text, 1–3 words (4 only when three cannot say it) / 24 characters — "Yes, fix 1", "Fix 2 instead", "Not now": a button, not a sentence; the detail goes in message. No leading / or !. Ignored for an app action (the app\'s own label is used).',
          ),
        message: z.string().optional().describe('For a reply: what the click sends, up to 300 characters of plain text — no leading / or !. Omit when the label is the whole message.'),
      }),
    )
    .optional()
    .describe(
      '1–2 buttons, recommendation first. They are answers to your ask: the first accepts your recommendation, and another is there only when it is a realistic alternative the user might pick instead — not a menu of everything you mentioned. When blocked is true, they are the most likely answers to your question. While Auto-fix is on for the session\'s PR, none offers to watch it, fix CI, resolve conflicts or address comments.',
    ),
  ask: z
    .string()
    .optional()
    .describe(
      "The one question (≤100 chars) when the next move is the user's call — a choice, a go-ahead (to act here on what this turn found, say), an approval: the decision alone, with no reason or recommendation and without listing the options the buttons give (actions[0] is your pick). Like the recap, never point at anything else in the conversation. Omit it, and actions, when nothing waits on the user.",
    ),
  blocked: z.boolean().optional().describe('true when your work stops here until the user answers (the app marks the session as waiting on them); omit when the answer can wait.'),
  recap: z
    .string()
    .describe(
      'Two or three short sentences to the user (≤300 chars): what is now true or changed, then where it stands, including what is not done or not verified. Its first sentence is the sidebar status. It must stand on its own, since it is also read away from the transcript and the box draws under anything you write after this call: never point at anything else in the conversation ("listed below", "see above", "in my message").',
    ),
}

/** The MCP servers of a conversation: ccd_turn with wrap_up, and review with the review tools. */
export function kumiServers(handlers: KumiToolHandlers): Record<string, McpServerConfig> {
  const run = async (a: ReviewAnswer) => {
    try {
      return { content: [{ type: 'text' as const, text: handlers.answer(a) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
    }
  }
  const finding = z.number().int().describe('The number of the finding, from the relayed <code-review> message.')
  const wrapUp = tool('wrap_up', WRAP_UP_DESCRIPTION, wrapUpShape, async (args) => {
    const result = await handlers.wrapUp(args as Record<string, unknown>)
    return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError }
  })
  // Their input shapes differ.
  const reviewTools: SdkMcpToolDefinition<any>[] = [
    tool(
      'respond_to_finding',
      'Answer a code review finding relayed to you from the reviewer (a <code-review> message). Call it once per relayed finding, after you have fixed it or decided that it needs no change: the answer goes to the reviewer at once, and it checks the code then.',
      {
        finding,
        outcome: z.enum(['fixed', 'no_change_needed']).describe('"fixed": you changed the code to address it. "no_change_needed": the finding is wrong, or a change would be; you push back.'),
        reply: z.string().describe('For the reviewer: what you changed and where, or why no change is needed. Be specific; the reviewer has not seen this conversation.'),
      },
      (args) => run({ role: 'implementer', ...args }),
    ),
    tool(
      'resolve_finding',
      "Give your verdict on the implementer's answer to one of your code review findings, relayed to you (a <code-review> message). You can also reopen a finding you settled before, to send it back to the implementer: say, to undo a fix for a finding that turned out wrong, with what the implementer should do as the reply. To withdraw one of your findings at any time, even one already settled, call ReportFindings again with that finding and outcome \"no_change_needed\" (\"skipped\" when it is not worth doing); outcome \"fixed\" marks it fixed and verified.",
      {
        finding,
        verdict: z.enum(['accept', 'reopen']).describe('"accept": the fix holds, or the push-back answers your finding. "reopen": it does not, or a finding you settled must go back to the implementer.'),
        reply: z.string().describe('Your reason, for the implementer and the user. When reopening, say what is still wrong.'),
      },
      (args) => run({ role: 'reviewer', ...args }),
    ),
  ]
  return {
    ccd_turn: createSdkMcpServer({ name: 'ccd_turn', tools: [wrapUp], alwaysLoad: true }),
    review: createSdkMcpServer({ name: 'review', tools: reviewTools, alwaysLoad: true }),
  }
}
