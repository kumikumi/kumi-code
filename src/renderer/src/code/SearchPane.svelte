<!-- Search: the folder's files' contents, through ripgrep as in VS Code. It searches as you type; a result opens its file at the match in a preview tab. -->
<script lang="ts">
  import Icon from '../Icon.svelte'
  import FileIcon from './FileIcon.svelte'
  import { basename, dirname } from './view.svelte'
  import type { CodeView } from './view.svelte'

  let { view }: { view: CodeView } = $props()

  /** VS Code's `search.searchOnTypeDebouncePeriod`. */
  const DEBOUNCE = 300

  let input = $state<HTMLInputElement>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const result = $derived(view.result)
  const fileCount = $derived(result?.files.length ?? 0)

  $effect(() => {
    if (view.focusSearch && input) {
      input.focus()
      input.select()
    }
  })

  function soon(delay = DEBOUNCE): void {
    clearTimeout(timer)
    timer = setTimeout(() => void view.runSearch(), delay)
  }

  function toggle(key: 'matchCase' | 'wholeWord' | 'regex'): void {
    view.query[key] = !view.query[key]
    soon(0)
  }

  /** The preview as VS Code shows it: leading whitespace dropped, long lead-ins cut short. */
  function shown(preview: string, start: number): { before: string; cut: boolean } {
    const before = preview.slice(0, start).trimStart()
    return before.length > 26 ? { before: before.slice(-20), cut: true } : { before, cut: false }
  }

  function summary(): string {
    if (!result) return ''
    if (result.matchCount === 0) return 'No results found. Review your settings for configured exclusions and check your gitignore files.'
    const matches = `${result.matchCount} result${result.matchCount === 1 ? '' : 's'}`
    return `${matches} in ${fileCount} file${fileCount === 1 ? '' : 's'}${result.limitHit ? ' — the search stopped at the result limit' : ''}`
  }
</script>

<div class="side-pane search-pane">
  <div class="search-form">
    <div class="search-box">
      <input
        bind:this={input}
        bind:value={view.query.pattern}
        placeholder="Search"
        spellcheck="false"
        aria-label="Search"
        oninput={() => soon()}
        onkeydown={(e) => e.key === 'Enter' && soon(0)}
      />
      <button class={['search-toggle', view.query.matchCase && 'on']} title="Match Case (⌥⌘C)" aria-pressed={view.query.matchCase} onclick={() => toggle('matchCase')}>Aa</button>
      <button class={['search-toggle', 'word', view.query.wholeWord && 'on']} title="Match Whole Word (⌥⌘W)" aria-pressed={view.query.wholeWord} onclick={() => toggle('wholeWord')}>ab</button>
      <button class={['search-toggle', view.query.regex && 'on']} title="Use Regular Expression (⌥⌘R)" aria-pressed={view.query.regex} onclick={() => toggle('regex')}>.*</button>
    </div>
    <div class="search-details-toggle">
      <button class={['ghost icon-button', view.searchDetails && 'pane-on']} aria-label="Toggle Search Details" title="Toggle Search Details" onclick={() => (view.searchDetails = !view.searchDetails)}><Icon name="more" /></button>
    </div>
    {#if view.searchDetails}
      <label class="search-field">files to include<input bind:value={view.query.include} placeholder="e.g. *.ts, src/**/include" spellcheck="false" oninput={() => soon()} onkeydown={(e) => e.key === 'Enter' && soon(0)} /></label>
      <label class="search-field">files to exclude<input bind:value={view.query.exclude} placeholder="e.g. *.ts, src/**/exclude" spellcheck="false" oninput={() => soon()} onkeydown={(e) => e.key === 'Enter' && soon(0)} /></label>
    {/if}
  </div>
  {#if view.searching}<div class="side-progress"></div>{/if}
  {#if view.searchError}<div class="side-error">{view.searchError}</div>
  {:else if result}
    <div class="search-summary">
      <span>{summary()}</span>
      <button class="ghost icon-button" aria-label="Refresh" title="Refresh" onclick={() => void view.runSearch()}><Icon name="reload" /></button>
      <button class="ghost icon-button" aria-label="Clear Search Results" title="Clear Search Results" onclick={() => view.clearSearch()}><Icon name="clear" /></button>
      <button class="ghost icon-button" aria-label="Collapse All" title="Collapse All" onclick={() => result.files.forEach((f) => view.collapsedResults.add(f.path))}><Icon name="collapse" /></button>
    </div>
  {/if}
  <div class="tree search-results" role="tree">
    {#each result?.files ?? [] as file (file.path)}
      {@const collapsed = view.collapsedResults.has(file.path)}
      {@const abs = `${view.cwd}/${file.path}`}
      <div
        class="tree-row search-file"
        role="treeitem"
        aria-selected="false"
        aria-expanded={!collapsed}
        tabindex="-1"
        title={file.path}
        onclick={() => (collapsed ? view.collapsedResults.delete(file.path) : view.collapsedResults.add(file.path))}
        onkeydown={() => {}}
      >
        <span class="tree-twistie"><Icon name={collapsed ? 'chevronRight' : 'chevronDown'} /></span>
        <FileIcon name={basename(file.path)} />
        <span class="tree-name">{basename(file.path)}</span>
        <span class="tree-description">{file.path.includes('/') ? dirname(file.path) : ''}</span>
        <span class="search-count">{file.matches.length}</span>
      </div>
      {#if !collapsed}
        {#each file.matches as match, i (i)}
          {@const lead = shown(match.preview, match.start)}
          {@const opened = view.searchOpened?.path === file.path && view.searchOpened.index === i && view.activeId === `file:${abs}`}
          <div
            class={['tree-row search-match', opened && 'selected']}
            role="treeitem"
            aria-selected={opened}
            tabindex="-1"
            title={`${file.path}:${match.line}:${match.column}`}
            onclick={(e) => {
              view.searchOpened = { path: file.path, index: i }
              view.openFile(abs, { preview: e.detail < 2, focus: e.detail >= 2, line: match.line, column: match.column, length: match.length })
            }}
            onkeydown={() => {}}
          >
            <span class="search-preview">{lead.cut ? '…' : ''}{lead.before}<mark>{match.preview.slice(match.start, match.start + match.length)}</mark>{match.preview.slice(match.start + match.length)}</span>
          </div>
        {/each}
      {/if}
    {/each}
  </div>
</div>
