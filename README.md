# Kumi Code

A barebones Claude Code frontend. TypeScript, Electron, Svelte and Anthropic's Claude Agent SDK.
`SPEC.md` is the source of truth for what the code does; this file is the short version.

## Model

- **Conversation**: one user and one agent, as in Claude Code. A conversation is a Claude Code
  session: the SDK writes its transcript under `~/.claude/projects/`, the same place the `claude`
  CLI does, and Kumi Code reads it back from there. Kumi Code keeps no copy of the messages.
- **Agent**: Claude Code itself, run through the Agent SDK with Claude Code's own system prompt,
  tools, skills, subagents, slash commands, plugins, MCP servers, hooks, permission rules,
  `CLAUDE.md` files and auto-memory. User, project and local settings all load, so an agent
  here behaves like `claude` in the same folder.
- **Project**: the folder a conversation works in. "No project" gives the conversation a fresh,
  empty folder of its own under Kumi Code's data directory, like Claude Code's desktop app does.
- **Tabs and windows**: every tab is a conversation or a new tab page. Tabs reorder by dragging,
  move between windows by dragging onto another window's tab strip, and tear off into a new
  window by dragging them out. Windows and their tabs come back when the app restarts.
- **Code review**: a reviewer conversation's `ReportFindings` call links to the conversation
  that wrote the code. Kumi Code relays the findings the user sends to the implementer (which
  fixes each or pushes back) and each answer straight on to the reviewer (which accepts or
  reopens it); the agents answer through Kumi Code's own tools. The user picks which finding
  goes next and can close any finding with a click.
- **Browser**: each conversation has its own browser, with the tools of the Claude desktop
  app's browser pane as `mcp__browser__*`. Its tabs render offscreen at their own viewport, so
  they work whether or not anyone looks; the pane beside the transcript shows them scaled to fit
  and passes the user's mouse and keyboard on. Local pages need no permission; other sites ask.
- **Next step**: agents end a turn that did work with `mcp__ccd_turn__wrap_up`, the Claude desktop app's tool
  for its next-step box: a recap and, when something waits on the user, a question with reply
  buttons that answer it.
- **Terminal**: each conversation has a Terminal panel of shell tabs that the user types in, with
  the tools of the Claude desktop app's Terminal panel (`mcp__terminal__*`): the agent reads what
  the user ran, and runs commands there that the user approves, line by line. With one more tool,
  `send_to_terminal`, the agent types text and presses keys in any tab, the user's own included,
  so it can work in a shell the user logged in to over SSH or navigate a full-screen program.
- **New tab page**: past conversations (those started in Kumi Code, or every Claude Code session
  on this machine with the toggle) and a new conversation in a recent project, a picked folder
  or no project.

## Rules

- Subscriptions only. The agent authenticates with the Claude subscription login that Claude
  Code keeps on this machine; Kumi Code never authenticates by itself and has no sign-in of its
  own. When logged out, it shows the bundled CLI's `auth login` command to run in a terminal.
  Every `CLAUDE*` and `ANTHROPIC_*` variable of the launching process except `CLAUDE_CONFIG_DIR`
  is dropped from the agent's environment, so an inherited API key cannot switch billing.
- Anthropic models only.
- No fallbacks. If something fails, it errors immediately and visibly.
- No backward compatibility while prototyping. A state file from another version is an error.

## Run

```bash
bun install
bun run dev
```

`bun run typecheck` checks the main-process and renderer projects; `bun run test` runs the unit
tests; `bun run e2e` builds the app (with an unminified UI, `--mode e2e`) and drives it with Playwright (it opens real windows, sends
a few short messages to Claude Haiku on your subscription, and never touches the real mouse).

Kumi Code's own state (windows, tabs, recent projects, which conversations it started and their
settings, code reviews) lives in `~/Library/Application Support/Kumi Code/state.json`; project-less
conversations get folders under `~/Library/Application Support/Kumi Code/scratch/`.
