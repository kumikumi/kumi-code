// Kumi Code's own tools for a conversation in a code review: the implementer
// answers a finding Kumi Code relayed, and the reviewer gives its verdict on the
// answer. They run in the main process, as an in-process MCP server named kumi.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ReviewRole } from '@shared/types'
import type { ReviewAnswer } from './review'

/** Allowed without asking: all they do is record an answer in Kumi Code. */
export const REVIEW_TOOLS = ['mcp__kumi__respond_to_finding', 'mcp__kumi__resolve_finding']

/**
 * The MCP servers for a conversation with these review roles: the tool of each
 * role. `answer` returns what the tool tells the agent, or throws it as an error.
 */
export function reviewServers(roles: ReviewRole[], answer: (a: ReviewAnswer) => string): Record<string, McpServerConfig> {
  if (roles.length === 0) return {}
  const run = async (a: ReviewAnswer) => {
    try {
      return { content: [{ type: 'text' as const, text: answer(a) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
    }
  }
  const finding = z.number().int().describe('The number of the finding, from the relayed <kumi-review> message.')
  const tools = []
  if (roles.includes('implementer')) {
    tools.push(
      tool(
        'respond_to_finding',
        'Answer a code review finding that Kumi Code relayed to you from the reviewer (a <kumi-review> message). Call it once per relayed finding, after you have fixed it or decided that it needs no change: the answer goes to the reviewer at once, and it checks the code then.',
        {
          finding,
          outcome: z.enum(['fixed', 'no_change_needed']).describe('"fixed": you changed the code to address it. "no_change_needed": the finding is wrong, or a change would be; you push back.'),
          reply: z.string().describe('For the reviewer: what you changed and where, or why no change is needed. Be specific; the reviewer has not seen this conversation.'),
        },
        (args) => run({ role: 'implementer', ...args }),
      ),
    )
  }
  if (roles.includes('reviewer')) {
    tools.push(
      tool(
        'resolve_finding',
        "Give your verdict on the implementer's answer to one of your code review findings, which Kumi Code relayed to you (a <kumi-review> message).",
        {
          finding,
          verdict: z.enum(['accept', 'reopen']).describe('"accept": the fix holds, or the push-back answers your finding. "reopen": it does not.'),
          reply: z.string().describe('Your reason, for the implementer and the user. When reopening, say what is still wrong.'),
        },
        (args) => run({ role: 'reviewer', ...args }),
      ),
    )
  }
  return { kumi: createSdkMcpServer({ name: 'kumi', tools, alwaysLoad: true }) }
}
