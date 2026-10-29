<!-- The new tab page: start a conversation in a recent project, a picked folder or no project, or open a past one. -->
<script lang="ts">
  import type { AuthStatus, ConversationSummary, RecentProject } from '@shared/types'
  import { api, app } from './state.svelte'
  import { clockTime, errorMessage, groupByDate, shortTime, tildify } from './util'

  let { tabId, visible }: { tabId: string; visible: boolean } = $props()

  let auth = $state<AuthStatus | null>(null)
  let authError = $state<string | null>(null)
  let projects = $state.raw<RecentProject[] | null>(null)
  let conversations = $state.raw<ConversationSummary[] | null>(null)
  let all = $state(false)
  let query = $state('')
  let error = $state<string | null>(null)
  let renaming = $state<{ id: string; title: string } | null>(null)

  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const matches = (c: ConversationSummary): boolean => [c.title, c.project ?? 'no project', c.cwd].some((s) => s.toLowerCase().includes(q))
    return groupByDate((conversations ?? []).filter((c) => !q || matches(c)), (c) => c.lastActive)
  })

  function run(p: Promise<unknown>): void {
    error = null
    p.catch((err: unknown) => (error = errorMessage(err)))
  }

  function checkAuth(): void {
    authError = null
    api.getAuthStatus().then(
      (status) => (auth = status),
      (err: unknown) => (authError = errorMessage(err)),
    )
  }

  function refresh(): void {
    run(api.listRecentProjects().then((list) => (projects = list)))
    run(api.listConversations(all).then((list) => (conversations = list)))
  }

  $effect(() => {
    if (visible) refresh()
  })
  $effect(() => {
    if (visible) checkAuth()
  })
  $effect(() => api.onConversationsChanged(refresh))

  function saveTitle(): void {
    const r = renaming
    renaming = null
    const current = conversations?.find((c) => c.id === r?.id)
    if (r && r.title.trim() && r.title.trim() !== current?.title) run(api.renameConversation(r.id, r.title.trim()))
  }

  function remove(c: ConversationSummary): void {
    if (window.confirm(`Delete "${c.title}"? Its transcript is removed from ~/.claude/projects.`)) run(api.deleteConversation(c.id))
  }
</script>

<div class="newtab">
  <div class="newtab-inner">
    <header class="newtab-header">
      <h1>Kumi Code</h1>
      <div class="account">
        {#if auth?.loggedIn}<span>{auth.email ?? 'Signed in'}{auth.subscriptionType ? ` · ${auth.subscriptionType}` : ''}</span>{/if}
        {#if app.usage}
          <span title={app.usage.resetsAt ? `Resets at ${clockTime(app.usage.resetsAt)}` : undefined}>5-hour usage {app.usage.utilization}%</span>
        {/if}
      </div>
    </header>

    {#if authError}<div class="banner error">Could not read the Claude login: {authError}</div>{/if}
    {#if auth && !auth.loggedIn}
      <div class="banner">
        <p>Kumi Code uses the Claude subscription login that Claude Code keeps on this machine. You are not logged in. Run this in a terminal, then check again:</p>
        <code class="command">{auth.loginCommand}</code>
        <div class="row">
          <button onclick={() => auth && navigator.clipboard.writeText(auth.loginCommand)}>Copy command</button>
          <button class="primary" onclick={checkAuth}>Check again</button>
        </div>
      </div>
    {/if}
    {#if error}<div class="banner error">{error}</div>{/if}

    <section>
      <h2>New conversation</h2>
      <div class="projects">
        {#each projects ?? [] as p (p.path)}
          <button class="project" onclick={() => run(api.startConversation(tabId, p.path))} title={p.path}>
            <span class="project-name">{p.name}</span>
            <span class="project-path">{tildify(p.path)}</span>
          </button>
        {/each}
        <button class="project action" onclick={() => run(api.pickFolder().then((path) => (path ? api.startConversation(tabId, path) : undefined)))}>
          <span class="project-name">Open folder…</span>
          <span class="project-path">Work in a folder of your choice</span>
        </button>
        <button class="project action" onclick={() => run(api.startConversation(tabId, null))}>
          <span class="project-name">No project</span>
          <span class="project-path">Start in a new empty folder</span>
        </button>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Conversations</h2>
        <input class="search" placeholder="Search" bind:value={query} />
        <label class="toggle" title="Include Claude Code sessions started outside Kumi Code">
          <input type="checkbox" bind:checked={all} />
          All Claude Code sessions
        </label>
      </div>
      {#if conversations === null}
        <div class="muted">Loading…</div>
      {:else if groups.length === 0}
        <div class="muted">{query ? 'No matches.' : 'No conversations yet.'}</div>
      {/if}
      {#each groups as group (group.label)}
        <div class="conversation-group">
          <h3>{group.label}</h3>
          <ul class="conversations">
            {#each group.items as c (c.id)}
              <li class="conversation-row">
                {#if renaming?.id === c.id}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    autofocus
                    class="rename"
                    bind:value={renaming.title}
                    onblur={saveTitle}
                    onkeydown={(e) => (e.key === 'Enter' ? saveTitle() : e.key === 'Escape' && (renaming = null))}
                  />
                {:else}
                  <button class="conversation-open" onclick={() => run(api.openConversation(tabId, c.id))}>
                    <span class="conversation-title">{c.title}</span>
                    <span class="conversation-meta">{c.project ?? 'No project'}{c.gitBranch ? ` · ${c.gitBranch}` : ''}{c.kumi ? '' : ' · Claude Code'}</span>
                    <span class="conversation-time" title={new Date(c.lastActive).toLocaleString()}>{shortTime(c.lastActive)}</span>
                  </button>
                {/if}
                <div class="row-actions">
                  <button class="ghost small" onclick={() => (renaming = { id: c.id, title: c.title })}>Rename</button>
                  <button class="ghost small danger-text" onclick={() => remove(c)}>Delete</button>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </section>
  </div>
</div>
