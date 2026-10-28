// The environment of the Claude Code processes Kumi Code starts. Everything
// Claude- or Anthropic-specific from the launching process is dropped: an
// inherited API key, base URL or Claude Code session marker would change how the
// agent authenticates or behaves. Only CLAUDE_CONFIG_DIR passes through, because
// it decides where the subscription login, settings and transcripts live.
// Kumi Code then sets what it needs itself.

export const CLIENT_APP = 'kumi-code/0.1.0'

export function agentEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDE_CONFIG_DIR') env[key] = value
    else if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC_')) continue
    else env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP
  // Claude Code's task list tools (TaskCreate, TaskUpdate, ...), which the
  // interactive CLI has and an SDK session only gets when asked.
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1'
  return env
}
