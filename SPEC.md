# Kumi Code — specification

What the code does, precisely. `README.md` is the short version.

## Layout

- `src/core/` — no Electron imports.
  - `conversation.ts` — `Conversation`: one Claude Code session driven through the Agent SDK.
  - `transcript.ts` — `TranscriptBuilder`: SDK output and stored sessions → `TranscriptItem[]`.
  - `sessions.ts` — past conversations, recent projects, scratch folders.
  - `store.ts` — `Store`: Kumi Code's own state file.
  - `auth.ts` — login status via the bundled CLI (`claude auth status`).
  - `environment.ts` — the environment Claude Code processes run with.
  - `input-queue.ts` — the streaming input of a `query()`.
  - `review.ts` — `Reviews`: code review loops, and the relayed messages' format.
  - `review-tools.ts` — Kumi Code's MCP server with the agents' review tools.
- `src/main/` — Electron main process: `workspace.ts` (windows, tabs, open conversations),
  `drag.ts` (tabs dragged out of a strip), `index.ts` (IPC, menu, startup).
- `src/preload/` — the `window.kumi` bridge (`KumiApi` in `src/shared/types.ts`).
- `src/shared/` — `types.ts` (everything that crosses IPC), `review.ts` (review rules the main
  process and the renderer share).
- `src/renderer/` — Svelte 5 UI: `App.svelte` (a window), `TabStrip.svelte`, `NewTabPage.svelte`,
  `Conversation.svelte`, `Item.svelte` (a transcript item), `ToolInput.svelte`, `Requests.svelte`,
  `Composer.svelte`, `Rich.svelte` (markdown or a code block), `Todos.svelte`, `FindingsCard.svelte`,
  `FindingDetails.svelte`, `RelayCard.svelte`, `ReviewPanel.svelte`; `state.svelte.ts`
  (window and conversation state), `markdown.ts`, `tools.ts`, `util.ts`.

## Auth

- Kumi Code never authenticates and has no sign-in. The SDK's bundled CLI uses the credentials
  `claude auth login` stored on this machine.
- `getAuthStatus()` runs `<bundled claude> auth status` (non-zero exit still yields JSON). It must
  report `apiProvider: firstParty` and, when logged in, an OAuth method; anything else is an error.
- The new tab page shows the status; when logged out it shows `<bundled claude> auth login` with
  *Copy command* and *Check again*. A request that fails with `authentication_failed` shows the same
  command in the conversation.
- `agentEnvironment()`: `process.env` without any `CLAUDE*` or `ANTHROPIC_*` variable except
  `CLAUDE_CONFIG_DIR`, plus `CLAUDE_AGENT_SDK_CLIENT_APP=kumi-code/<version>` and
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (the task list tools TaskCreate/TaskUpdate/TaskList/TaskGet,
  which the interactive CLI has and an SDK session otherwise lacks). Used for every CLI process,
  including `auth status`.
- Tools: the `claude_code` preset. With `canUseTool` set it includes AskUserQuestion,
  EnterPlanMode and ExitPlanMode; Glob and Grep are absent as in native Claude Code builds.

## Conversations

- A conversation is a Claude Code session; its id is the session id, chosen by Kumi Code (UUID)
  and passed as `sessionId` to the first process, or `resume` once the session has a transcript
  (`getSessionInfo` finds it). History is read with `getSessionMessages`.
- One `query()` per running conversation, in streaming input mode (an `InputQueue`), so messages
  sent while a turn runs go straight to Claude Code, which queues them. Options:
  `tools` and `systemPrompt` = the `claude_code` preset; `settingSources: ['user','project','local']`;
  `skills: 'all'`; `permissionMode` from the conversation's settings;
  `allowDangerouslySkipPermissions: true` (so bypass can be chosen mid-session);
  `includePartialMessages: true`; `thinking: { type: 'adaptive', display: 'summarized' }`;
  `model`/`effort` when set; `canUseTool`; `env: agentEnvironment()`; `spawnClaudeCodeProcess`:
  Kumi Code starts the process itself (`child_process.spawn` with the SDK's command, arguments,
  folder, environment and abort signal) to know when it has exited, and keeps the last 50 chunks
  of its stderr for error messages.
- After `initializationResult()` the meta carries the model list (value, name, efforts, auto mode
  support) and the slash commands (Claude Code's own, skills, plugins, custom commands).
- Status: `cold` (no process) → `starting` → `idle` ⇄ `running`; `error` when the process fails
  (the error and the tail of stderr are shown; the next message starts a new process). A `result`
  ends a turn unless `queued_turn_count > 0`; stream or assistant output while idle (a turn Claude
  Code started by itself) sets `running`.
- The process starts when its tab is first shown (and on send), and stops when its tab closes,
  after 15 minutes idle with no pending request, or on quit. Stopping closes its input; Claude
  Code then finishes writing the transcript (the turn it was in, cost totals, the title) and
  exits, and the SDK force-kills it after about 2 s. `stop()` resolves when it has exited.
- Settings (model, effort, permission mode) are stored per conversation and applied live:
  `setModel`, `applyFlagSettings({ effortLevel })`, `setPermissionMode`. Mode changes Claude Code
  reports (`init`, `status`) are adopted.
- Requests (`canUseTool`): `AskUserQuestion` → a question form, answered with
  `updatedInput.answers` (question → label(s) joined by `, `, or the typed text);
  `ExitPlanMode` → plan approval (approve with `acceptEdits`, `auto` when the model supports it,
  or `default`, which also switches the mode; or keep planning with feedback, a deny);
  anything else → a permission prompt: *Allow*, *Always allow* (returns the CLI's suggestions as
  `updatedPermissions`; only when it offered some), *Deny* (denies and interrupts), or deny with a
  note (the note goes to the agent, the turn continues). A request whose signal aborts is removed.
- Interrupt: `query.interrupt()`; the turn's result shows as *Interrupted*.
- Title: the session's custom title or summary (`getSessionInfo`, refreshed after each turn);
  before that, the first line of the first message. Rename uses `renameSession`.
- Context meter: input + cache + output tokens of the last main-thread assistant message over the
  `contextWindow` of that message's model in the turn's `modelUsage` (which also lists models used
  on the side, e.g. for titles). Cleared by compaction.
- The 5-hour usage window comes from `rate_limit_event`s: `unifiedWindows.five_hour` (utilization
  0-1, reset in epoch seconds), and is shown on the new tab page.
- Task list: built from the task tools' calls and results (`TaskCreate` ids from the structured
  output, or from the result text `Task #<id> created…` in stored sessions; `TaskUpdate` status,
  subject and active form, `deleted` removes; `TaskList` replaces). It is in the meta and shows
  above the composer while a task is not completed; the task tools' own calls are not shown in the
  transcript unless they fail.

## Transcript

- Items: `user` (text, images, `queued`, `relay` for a relayed review message), `text`, `thinking`, `tool` (name, input, `partialInput`
  while it streams, `result`, `children` = what a subagent started by it did), `compact`,
  `command_output`, `notice` (info or error).
- Stream events create `text`/`thinking`/`tool` items and grow them; the complete assistant
  message (one per content block) settles them by API message id and kind, in order. Tool results
  attach by `tool_use_id`. Output with a `parent_tool_use_id` nests under that tool.
- Every change is reported against its top-level item; the main process sends changed top-level
  items, throttled to 40 ms, with a per-conversation revision number. A renderer fetches a snapshot
  (with its revision) when it first shows a conversation and ignores older events. It keeps the
  items as raw (unproxied) Svelte state and replaces the changed ones, so rows of unchanged items
  are left alone; rows take the folder as a derived string, so meta updates leave them alone too
  (`e2e/rows.mjs` counts the calls). If the snapshot cannot be fetched, the view shows the error and ignores the
  conversation's later events.
- Markdown: `marked` (GitHub-flavoured) to HTML, sanitized with DOMPurify (it is model output).
  Code blocks get a language label and a copy button, and are highlighted with Shiki (JavaScript
  regex engine, `github-dark-default`) once the text stops streaming. Links open in the browser.
- Callbacks the main process calls through the context bridge return nothing: the bridge clones a
  return value back, and a Svelte state proxy cannot be cloned.
- Stored user messages that Claude Code injected are classified: `<command-name>` → the command as
  a user message, `<local-command-stdout>` → command output, `<system-reminder>` and
  `<local-command-caveat>` → hidden, `<task-notification>` → its summary as a notice,
  `[Request interrupted by user…` → *Interrupted*, the compaction summary → a compaction divider.
- A failed model request (an assistant message with `error`) shows as one error notice; the
  turn's result does not repeat it.

## Windows and tabs

- The main process owns the layout: windows, each with ordered tabs and an active tab. A tab is a
  new tab page or one conversation; a conversation is in at most one tab (opening it again
  switches to that tab).
- The renderer of a window draws its tab strip and keeps a conversation's view mounted once shown.
- A conversation's unsent draft lives in the main process: the composer sends every change at
  once, so a tab moved to another window, whose composer starts from that copy, keeps all of it.
- A pending request's form (a permission note, question answers, plan feedback) is cleared only
  when a request with another id takes its place, not when the conversation's meta updates.
- Shortcuts: ⌘T new tab, ⌘N new window, ⌘W close tab, ⇧⌘W close window, ⇧⌘T reopen closed
  conversation tab, ⌘1–8 tab n, ⌘9 last tab, ⌃Tab / ⌃⇧Tab and ⇧⌘] / ⇧⌘[ next / previous tab.
  Middle click closes a tab. Closing a window's only tab closes the window.
- Dragging (`TabStrip.tsx`, `drag.ts`): within the strip a drag reorders (others slide aside).
  When the pointer leaves the strip by 28 px, or immediately for a window's only tab, the renderer
  calls `dragStart` and then `dragMove` per pointer move and `dragEnd` on release; the main process
  reads the cursor itself (`screen.getCursorScreenPoint()`). The tab gets a window that follows
  the cursor with the tab under it: a new window of the source's size, or the source window
  itself when it was the only tab. Over another window's strip (hit-tested against the tab
  geometry each renderer reports), that window shows a placeholder at the insertion index and the
  dragged window hides (fades to 35 % when it is the source window, which must keep receiving the
  pointer). Releasing there moves the tab and closes the emptied window; elsewhere the dragged
  window stays where it is.
- Layout persistence: windows (bounds, conversation per tab, active index) are saved on every
  change. Closing the last window keeps it saved, so the next launch restores it; closing it by
  closing its only tab does not. Stored bounds off every display are dropped.

## New tab page

- Login status and 5-hour usage.
- Recency is the time of a session's last message: the timestamp of the last `user` or
  `assistant` record of its transcript (`~/.claude/projects/*/<id>.jsonl`, read from the end).
  Not the file's modification time: Claude Code appends bookkeeping records (cost totals, tool
  latches) whenever a process for the session exits. Sessions without a message are left out, and
  so are sessions deleted between listing them and reading their file.
- *New conversation*: recent projects (Kumi Code's own recents, then the folders of other Claude
  Code sessions by their last message; existing folders only, not under Kumi Code's scratch root
  or `~/Library/Application Support/`; at most 12), *Open folder…*, *No project* (a new folder
  `<userData>/scratch/scratch-YYYY-MM-DD-<6 hex>`, mode 0700, like Claude Code's desktop app).
- *Conversations*: Kumi Code's conversations (or, with the toggle, every Claude Code session on
  this machine), most recently active first, grouped by local calendar date: Today, Yesterday,
  Previous 7 days, Previous 30 days, then by month (with the year when it is not this one). Each
  row shows the time this week and the date before. Search over title, project and folder keeps
  the grouping. Rename; delete (with confirmation) stops the conversation's process and waits
  until it has exited (an error after 10 s), so it cannot write the file back, then removes the
  transcript with `deleteSession` and closes the conversation's tab.
  Opening a session from elsewhere adds it to Kumi Code's conversations.

## Code review

- A review links one `ReportFindings` call of a *reviewer* conversation to the *implementer*
  conversation that wrote the code. Its id is the tool use id. A conversation is the implementer
  of at most one review and the reviewer of at most one: starting a review replaces the reviews
  either conversation has the same role in. A conversation cannot review itself.
- Findings keep the reviewer's order (most severe first) as their rank, and the reviewer's fields:
  file, line, short summary (the title; the summary when absent), summary, failure scenario,
  category, verdict (`CONFIRMED`/`PLAUSIBLE`).
- A finding's status: `open` → (sent) `implementing` → the implementer answers `fixed` or
  `pushed_back` → (sent at once) `verifying` → the reviewer accepts (`resolved` after a fix,
  `withdrawn` after a push-back) or reopens (`reopened` → sent back to the implementer). `closed`:
  the user closed it, from any status; reopening returns it to that status. Resolved, withdrawn
  and closed findings are settled.
- The user picks any finding and sends it to the implementer (open and reopened findings), with
  an optional note. The implementer's answer goes to the reviewer as soon as it is given, from
  the tool call; the user sends a fixed or pushed-back finding only when that failed or when
  they reopen one they closed in that state. A finding is with its agent from the moment it is
  sent: one whose message could not be delivered, or whose agent ended a turn (running →
  anything else) without answering, is *stalled* and can be sent again. Sending to a
  conversation no tab shows opens it in a new tab after the active one (for the implementer's
  answer: after the implementer's tab).
- A relayed message is a user message: `<kumi-review>`, one line of JSON (`RelayMessage`: the
  finding, the other agent's latest answer, the user's note), `</kumi-review>`, then instructions.
  The implementer is told the reviewer has a fresh context and can be wrong, to check the claim,
  fix it or push back, that the user's note outranks both agents, and to answer only when the
  code is final, since the reviewer checks it at once. The reviewer is told the
  implementer has context it lacks, to verify a fix or weigh a push-back, not to reopen only to
  restate the finding, and not to change the code. The transcript shows these messages, live and
  stored, as relay cards.
- The agents answer with Kumi Code's tools, an in-process MCP server `kumi` (`alwaysLoad`):
  `respond_to_finding({ finding, outcome: fixed | no_change_needed, reply })` for the implementer,
  `resolve_finding({ finding, verdict: accept | reopen, reply })` for the reviewer. A conversation
  gets the tools of the roles it has (at spawn, and with `setMcpServers` when its roles change);
  `allowedTools` allows both without asking. An answer to a finding that is not waiting on that
  agent is a tool error; one the user closed says so.
- UI: a `ReportFindings` call shows as a findings card (ranked rows that expand to details, the
  review's status per finding, and *Start review loop…*, which picks the implementer among Kumi
  Code's conversations, this folder's first). A conversation in a review shows the review panel
  beside the transcript: every finding with its status, *Close* / *Reopen* per row, and the
  current finding (the one picked, else the first that can be sent) with its thread (each entry
  headed by its speaker, colored by role), a note field and the send button (⌘↵). Sending a finding picks it; a picked finding that gets settled hands over to the next. *Reviewer* /
  *Implementer* switches to the other conversation; *End* removes the review. The panel's left
  edge resizes it (drag, or ← / → when focused; a double-click restores 340 px), between 280 px
  and the window's width less 400 px. The width is shared by the panels of a window and kept in
  the renderer's `localStorage` (`reviewPanelWidth`), not in the state file.
- Deleting a conversation ends its reviews.

## State

`<userData>/state.json` (`~/Library/Application Support/Kumi Code/`, or `KUMI_USER_DATA`), mode
0600, written atomically 300 ms after a change and on quit: `{ version: 2, windows, conversations:
{ [id]: { cwd, scratch, createdAt, model, effort, permissionMode } }, recents, reviews: { [id]:
Review } }`. Another version is an error. Transcripts live where Claude Code keeps them, under `~/.claude/projects/`.

## Not yet

Packaging (and with it a login-shell `PATH` for apps started from Finder), @-file mentions,
rewind and fork, diff and git panels, a terminal, settings and MCP screens, worktrees,
notifications, light theme, non-Anthropic models. For code review: relaying without a click per
step, starting a reviewer from the implementer, and review rounds after the fixes.
