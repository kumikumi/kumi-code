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
  - `kumi-tools.ts` — Kumi Code's own MCP servers: `ccd_turn` (`wrap_up`) and `review` (the review
    tools).
  - `wrap-up.ts` — what a `wrap_up` call tells the agent.
  - `keys.ts` — key names and shortcuts → DevTools protocol key events.
  - `urls.ts` — local pages, typed URLs, origins, redaction.
  - `previews.ts` — `Previews`: dev servers from a project's `.claude/launch.json`.
- `src/main/` — Electron main process: `workspace.ts` (windows, tabs, open conversations and
  their browsers), `drag.ts` (tabs dragged out of a strip), `index.ts` (IPC, menu, startup),
  `browser.ts` (`Browser`, `BrowserTab`: a conversation's offscreen tabs), `browser-tools.ts` (the
  `browser` MCP server), `browser-page.ts` (the helper the tools run inside a page).
- `src/preload/` — the `window.kumi` bridge (`KumiApi` in `src/shared/types.ts`).
- `src/shared/` — `types.ts` (everything that crosses IPC), `review.ts` (review rules the main
  process and the renderer share), `wrap-up.ts` (reading a `wrap_up` call).
- `src/renderer/` — Svelte 5 UI: `App.svelte` (a window), `TabStrip.svelte`, `NewTabPage.svelte`,
  `Conversation.svelte`, `Item.svelte` (a transcript item), `ToolInput.svelte`, `Requests.svelte`,
  `Composer.svelte`, `Rich.svelte` (markdown or a code block), `Todos.svelte`, `FindingsCard.svelte`,
  `FindingDetails.svelte`, `RelayCard.svelte`, `ReviewPanel.svelte`, `Dock.svelte` (the pane beside
  the transcript), `BrowserPane.svelte`, `NextStep.svelte`; `state.svelte.ts`
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
  sent: one whose message could not be delivered, whose agent ended a turn (running →
  anything else) without answering, or that was with an agent when Kumi Code last quit, is
  *stalled* and can be sent again. Sending to a
  conversation no tab shows opens it in a new tab after the active one (for the implementer's
  answer: after the implementer's tab).
- A relayed message is a user message: `<code-review>`, one line of JSON (`RelayMessage`: the
  finding, the other agent's latest answer, the user's note), `</code-review>`, then instructions.
  The implementer is told the reviewer has a fresh context and can be wrong, to check the claim,
  fix it or push back, that the user's note outranks both agents, and to answer only when the
  code is final, since the reviewer checks it at once. The reviewer is told the
  implementer has context it lacks, to verify a fix or weigh a push-back, not to reopen only to
  restate the finding, and not to change the code. The transcript shows these messages, live and
  stored, as relay cards.
- The agents answer with tools of Kumi Code's MCP server `review` (see Next step):
  `respond_to_finding({ finding, outcome: fixed | no_change_needed, reply })` for the implementer,
  `resolve_finding({ finding, verdict: accept | reopen, reply })` for the reviewer, who may also
  reopen a finding it settled (resolved or withdrawn): it goes back to the implementer, say to undo
  a fix for a finding that was wrong, which the implementer is told to answer as needing no change.
  Every
  conversation has both, always loaded; a call
  from a conversation that is not that review's implementer or reviewer, or about a finding that
  is not waiting on that agent, is a tool error, and one about a finding the user closed says so.
- UI: a `ReportFindings` call shows as a findings card (ranked rows that expand to details, the
  review's status per finding, and *Start review loop…*, which picks the implementer among Kumi
  Code's conversations, this folder's first). A conversation in a review shows the review panel
  beside the transcript (the dock, see Browser): every finding with its status, *Close* / *Reopen* per row, and the
  current finding (the one picked, else the first that can be sent) with its thread (each entry
  headed by its speaker, colored by role), a note field and the send button (⌘↵). Sending a finding picks it, and a picked finding stays the current one, settled or not, until
  the user picks another. *Reviewer* /
  *Implementer* switches to the other conversation; *End* removes the review.
- The reviewer can say at any time what became of its findings, as Claude Code's agents do: by
  calling `ReportFindings` again with an `outcome` on findings. Kumi Code sees the call finish
  (`onToolDone`) and, when it comes from a review's reviewer and is not the call the review came
  from, matches each finding to the review's (same file and summary, else file and title, else
  file and line; each once) and applies its outcome in any status but closed: `fixed` → resolved,
  `no_change_needed` and `skipped` → withdrawn, each with a thread entry ("Reviewer · withdrew it").
  The reviewer's relayed instructions and `resolve_finding`'s description tell it so. The call's
  card shows as *Findings reported again*, each outcome with the finding it went to, and offers no
  new review.
- Deleting a conversation ends its reviews.

## Next step

- Every conversation gets Kumi Code's in-process MCP servers `ccd_turn`, `review` and `browser`,
  made for each Claude Code process and the same while it runs (Claude Code keeps a server it has
  by its name, so swapping one mid-session would not change its tools). The tools of `ccd_turn`
  and `review` are always loaded, so an agent has their schemas without a tool search, and are in
  `allowedTools`.
- Nothing an agent reads names Kumi Code: not the server or tool names, the relayed messages, the
  tool descriptions and results, the browser's instructions or the system prompt section (which
  says "the app"). An agent told that Kumi Code relayed something took Kumi Code for one more
  party in the work.
- `ccd_turn` serves `wrap_up`, so the agent sees `mcp__ccd_turn__wrap_up`: the Claude desktop app's
  tool that fills the next-step box at the end of a turn, with its name, input schema (`recap`;
  optional `ask`, `actions` of up to two buttons, `blocked`) and description. The description
  leaves out the desktop app's sentence about its `update_plan` tool, which Kumi Code does not
  have.
- A section appended to Claude Code's system prompt (`KUMI_INSTRUCTIONS`) says when to call it, as
  the desktop app's own instructions do: at the end of every turn that changed files, ran
  commands or did multi-step work, before the closing message. It also says that the app's one
  action is `commit`, which holds while the project is a git repository with uncommitted changes:
  the desktop app reports available actions in its `update_plan` results, which Kumi Code does not
  have.
- App actions: `commit` holds while `git status --porcelain` in the conversation's folder lists
  anything (checked when `wrap_up` is called); its button is *Commit* and a click sends "Commit the
  changes." for the agent to do. The schema's other actions are not actions Kumi Code has.
- The result tells the agent whether the box shows its question. It refuses (a tool error) a
  call without a recap, with an app action that does not hold right now or that Kumi Code does not
  have (saying which are available), with more than two buttons, with buttons but no `ask`, or
  with a button that starts with `/` or `!` (it would run as a command). Fields that run long get
  advice for the next call.
- The box: the last successful `wrap_up` call with an `ask` and no user message after it shows,
  below the transcript, as its recap, its question and its buttons in the agent's order, the first
  as the primary one. A click sends the button's `message` (a reply's label when it has none) as
  the user's message, which ends the box. A call without an `ask` draws no box. `wrap_up` calls do not show
  in the transcript unless they fail. A `blocked` call marks the conversation as waiting
  (`meta.waiting`): its tab shows the attention dot until the next message.

## Browser

- Each open conversation may have a browser: tabs the agent drives with the browser tools and
  the user watches, and can use, in the browser pane. It is created on first use and closes
  with the conversation's tab (and on quit).
- A tab is an offscreen `BrowserWindow` that is never shown (`offscreen`, `backgroundThrottling:
  false`, 30 frames a second at most). It renders at its own viewport whether or not anyone
  looks, so the pane's size, whether the conversation's tab shows, and anything else on the
  screen change nothing the page sees. The DevTools protocol (`webContents.debugger`, attached
  once the tab has loaded `about:blank`) carries input, evaluation, emulation, dialogs and the
  network log; console messages come from `console-message`. Tabs share the persistent profile
  `persist:browser`, with Electron and Kumi Code left out of its user agent; downloads and
  permission requests (camera, location, …) are refused. A page's new windows open as tabs;
  JavaScript dialogs are accepted and logged as console messages.
- Viewport: width × height in CSS pixels at device scale 1 (default 1280 × 800), set by sizing the
  window. A width under 768 also emulates a phone (mobile metrics, an Android Chrome user agent,
  5 touch points); a color scheme emulates `prefers-color-scheme`. Both last across navigation.
- Tools: the `browser` in-process MCP server copies the tool set of the Claude desktop app's
  browser pane (`Claude_Browser`): `browser_batch`, `computer`, `find`, `form_input`,
  `get_page_text`, `javascript_tool`, `navigate`, `preview_list`, `preview_logs`, `preview_start`,
  `preview_stop`, `read_console_messages`, `read_network_requests`, `read_page`, `resize_window`,
  `tabs_close`, `tabs_context`, `tabs_create`, `tabs_select`, with the same parameters. Notes:
  - Without a `tabId` a tool acts on the active tab. `navigate` (with no tab open) and
    `preview_start` open one.
  - Screenshots are JPEG at page pixels scaled down to a frame of at most 1568 px on the long
    side, and further by `scale`; coordinates are in that frame, refs click the element's center
    (scrolled into view; visual viewport scale and offset applied).
  - `read_page`/`find` use a helper in an isolated world (`browser-page.ts`): an accessibility-style
    tree with `ref_N` for every element listed (text lines carry their parent's ref), hidden
    elements left out, open shadow roots included, iframes not. Refs last until navigation.
  - `javascript_tool` evaluates in the page's own world with REPL semantics.
  - `browser_batch` runs steps in order, stops at the first error, cannot nest, refuses
    `preview_start`, and refuses a step that would need the user's permission.
  - Network: the last 500 requests, secrets in URLs replaced with REDACTED; console: the last 1000
    messages.
- Permission: every browser tool is in `allowedTools` except `navigate`, `javascript_tool` and
  `preview_start`, which go through `canUseTool`. Kumi Code allows them without asking for
  local pages (`about:blank`, `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`), for
  origins the user allowed in this conversation (by allowing such a call, or by opening the page
  in the pane), for `javascript_tool` on such a page, and for a `preview_start` name the user
  allowed before; anything else shows the permission card.
- Dev servers (`previews.ts`): a configuration of `<project>/.claude/launch.json` (`name`,
  `runtimeExecutable`, `runtimeArgs`, `port`, optional `url`, `cwd`, `env`) starts in a process
  group of its own; `preview_start` waits until its port takes connections (90 s at most, or an
  error with the output's tail if it exits), then opens it in the tab that has its origin, a
  blank tab or a new one. A configuration with a `url` and no command attaches. Starting a
  running one reuses it; starting one whose port something else answers on is an error. The last
  5000 output lines are kept. Servers are shared by the conversations of a project.
- `preview_stop` stops everything the server started, such as the JVM `mvn spring-boot:run`
  forks: the processes of its group and every descendant of its first process (`ps`), also those
  that left the group. It sends SIGTERM, waits for all of them to exit, sends SIGKILL to what
  still runs after 15 s, and reports which happened and whether the port is free. On quit
  (also on SIGTERM to Kumi Code) every server gets SIGTERM, without waiting.
- The pane: the dock, beside the transcript, shows the review panel or the browser. The header's
  *Review* and *Browser* buttons toggle it; it opens by itself for a new review and for a
  browser's first tab when it is closed. Its left edge resizes it (drag, or ← / → when focused; a
  double-click restores the default: 340 px for the review, 560 px for the browser), between a
  minimum (280 / 320 px) and the window's width less 400 px. Widths are kept per kind in the
  renderer's `localStorage` (`reviewPanelWidth`, `browserPanelWidth`), shared by a window's panes.
- The browser pane: browser tabs (select, close, new), back / forward / reload, the URL field
  (opening a page there also allows its origin for the agent), the viewport (presets Desktop,
  Laptop 1440 × 900, Tablet, Mobile; width and height; color scheme) and DevTools for the tab. While
  a tool runs it shows what the tool does (its `action_summary`, or the tool). The page is a canvas
  drawn from JPEG frames of the active tab, which the main process sends only to windows that
  show the pane (`watchBrowser`), coalesced to 30 a second, and after viewport changes; it scales
  to fit. The user's mouse (with click counts), wheel and keys go back as DevTools protocol input
  in page pixels; ⌘ shortcuts for select all, copy, cut, paste, undo and redo become editing
  commands.

## State

`<userData>/state.json` (`~/Library/Application Support/Kumi Code/`, or `KUMI_USER_DATA`), mode
0600, written atomically 300 ms after a change and on quit: `{ version: 2, windows, conversations:
{ [id]: { cwd, scratch, createdAt, model, effort, permissionMode } }, recents, reviews: { [id]:
Review } }`. Another version is an error. Transcripts live where Claude Code keeps them, under `~/.claude/projects/`.

## Not yet

Packaging (and with it a login-shell `PATH` for apps started from Finder), @-file mentions,
rewind and fork, diff and git panels, a terminal, settings and MCP screens, worktrees,
notifications, light theme, non-Anthropic models. For code review: relaying without a click per
step, starting a reviewer from the implementer, and review rounds after the fixes. For the
browser: tabs restored after a restart, iframes in `read_page`, file uploads and downloads.
