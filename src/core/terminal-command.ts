// What run_in_terminal refuses to type into the user's shell before anything is
// typed: a line that is not one complete, printable command, and lines that would
// reach into the shell itself (its prompt, hooks, traps and history) rather than
// run a command. It is a subset of the Claude desktop app's list; the user's
// approval of the exact line is the rest. Lines the shell cannot parse are found
// by the shell itself (shellSyntaxError).

import { execFile } from 'node:child_process'
import { basename } from 'node:path'

/** Parameters that change the prompt, history or how the shell starts and reads input. */
const SHELL_PARAMETERS = [
  'PROMPT_COMMAND', 'HISTFILE', 'HISTSIZE', 'SAVEHIST', 'HISTCONTROL', 'histchars', 'STTY', 'module_path', 'fpath', 'FPATH', 'KEYBOARD_HACK', 'ZDOTDIR',
  'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT', 'PROMPT2', 'PROMPT3', 'PROMPT4', 'RPROMPT', 'RPROMPT2', 'RPS1', 'RPS2', 'MAILPATH', 'MAILCHECK', 'TMOUT', 'BASH_ENV', 'ENV',
]
/** Functions the shell calls by itself, which a line could define or replace. */
const SHELL_HOOKS = [
  'precmd', 'preexec', 'chpwd', 'periodic', 'zshaddhistory', 'zshexit', 'command_not_found_handler', 'command_not_found_handle', 'precmd_functions',
  'preexec_functions', 'chpwd_functions', 'zshexit_functions', 'vcs_info', '__git_ps1', 'git_prompt_info', 'add-zsh-hook', 'zle', 'bindkey', 'zstyle', 'sched',
]
const HISTORY_COMMANDS = ['fc', 'r', 'history', 'pushln']

/** Why the line may not be typed, or null when it may. */
export function refusal(command: string): string | null {
  if (!command.trim()) return 'The command is empty.'
  if (/[\r\n]/.test(command)) return 'The command has more than one line. Put longer scripts in a file and run the file.'
  if (/[^\x20-\x7e]/.test(command)) return 'The command has control or non-ASCII characters.'
  const outside = outsideSingleQuotes(command)
  // In double quotes ! and $_ still expand; # and << do not.
  const unquoted = outside.replace(/"(?:[^"\\]|\\.)*"/g, (q) => `"${' '.repeat(q.length - 2)}"`)
  if (/(\\|\|\||&&|\|)\s*$/.test(command)) return 'The line ends with a backslash or an operator, so the prompt would wait for more.'
  if (/(?<!<)<<(?!<)/.test(unquoted)) return 'Here-documents (<<) wait for more input. Put the text in a file instead.'
  if (/!(?=[^\s=)])/.test(outside)) return 'The line has a ! history expansion (such as !! or !$).'
  if (/(^|\s)#/.test(unquoted)) return 'A word starts with #, which would make the rest of the line a comment.'
  if (/\$_(?![A-Za-z0-9_])/.test(outside)) return 'The line reads $_, which depends on the shell\'s history.'
  for (const name of SHELL_PARAMETERS) {
    if (new RegExp(`(?<![$\\w])${name}(?!\\w)`).test(command)) return `The line names ${name}, which changes how the shell prompts, keeps history or starts.`
  }
  for (const name of SHELL_HOOKS) {
    if (new RegExp(`(?<![\\w-])${name.replace(/[-]/g, '\\-')}(?![\\w-])`).test(command)) return `The line names ${name}, a hook the shell runs by itself.`
  }
  if (/(^|[;&|(]\s*|\s)trap(\s|$)/.test(outside)) return 'The line sets a trap.'
  if (/(^|[;&|(]\s*|\s)(TRAP[A-Z]+|TRAP)\b/.test(outside)) return 'The line names a TRAP function.'
  for (const name of HISTORY_COMMANDS) {
    if (new RegExp(`(^|[;&|(]\\s*)${name}(\\s|$)`).test(outside)) return `The line runs ${name}, a history command.`
  }
  return null
}

/** The command with the text inside single quotes blanked out, where nothing is special. */
function outsideSingleQuotes(command: string): string {
  return command.replace(/'[^']*'/g, (q) => `'${' '.repeat(q.length - 2)}'`)
}

/** The shell's own error for a line it cannot parse, or null when it parses. */
export function shellSyntaxError(shell: string, command: string): Promise<string | null> {
  // zsh, bash and sh all read -n as "parse, do not run".
  return new Promise((done) => {
    execFile(shell, ['-n', '-c', command], { timeout: 5_000 }, (err, _stdout, stderr) => {
      done(err ? stderr.trim().replace(new RegExp(`^${basename(shell)}:\\s*`, 'gm'), '') || err.message : null)
    })
  })
}
