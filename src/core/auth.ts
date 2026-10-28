// Authentication status of the Claude subscription login the SDK uses.
//
// Kumi Code never authenticates by itself. The CLI binary bundled with the SDK
// reads the credentials that `claude auth login` stored on this machine. There
// is no API key path.

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type { AuthStatus } from '@shared/types'
import { agentEnvironment } from './environment'

const execFileAsync = promisify(execFile)

export function bundledClaudeBinary(): string {
  const require = createRequire(import.meta.url)
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  return require.resolve(`${pkg}/claude`)
}

interface CliAuthStatus {
  loggedIn: boolean
  authMethod: string
  apiProvider: string
  email?: string
  subscriptionType?: string
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const bin = bundledClaudeBinary()
  // The CLI exits non-zero when logged out but still prints the status JSON.
  const stdout = await execFileAsync(bin, ['auth', 'status'], { env: agentEnvironment() }).then(
    (r) => r.stdout,
    (err: unknown) => {
      const e = err as { stdout?: string; message?: string }
      if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('{')) return e.stdout
      throw new Error(`claude auth status failed: ${e.message ?? String(err)}`)
    },
  )
  const parsed = JSON.parse(stdout) as CliAuthStatus
  if (parsed.apiProvider !== 'firstParty') {
    throw new Error(`Unsupported API provider "${parsed.apiProvider}"; Kumi Code requires a Claude subscription login`)
  }
  if (parsed.loggedIn && parsed.authMethod !== 'oauth' && parsed.authMethod !== 'claude.ai') {
    throw new Error(`Logged in with "${parsed.authMethod}", but Kumi Code requires a Claude subscription login`)
  }
  return {
    loggedIn: parsed.loggedIn,
    authMethod: parsed.authMethod,
    email: parsed.email ?? null,
    subscriptionType: parsed.subscriptionType ?? null,
    loginCommand: loginCommand(),
  }
}

/** The bundled CLI's login command, for the user to run in a terminal. */
export function loginCommand(): string {
  return `${shellQuote(bundledClaudeBinary())} auth login`
}

function shellQuote(s: string): string {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}
