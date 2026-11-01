<!-- A tool's input as a person reads it: a command, a diff, file content, what is typed in a terminal, or JSON. -->
<script lang="ts">
  import { diffLines } from 'diff'
  import Rich from './Rich.svelte'
  import { langOf, terminalSteps } from './tools'
  import { str } from './util'

  let { name, input }: { name: string; input: Record<string, unknown> } = $props()

  const diff = $derived(
    name !== 'Edit'
      ? []
      : diffLines(str(input.old_string), str(input.new_string)).flatMap((part) => {
          const [kind, mark] = part.added ? ['diff-add', '+ '] : part.removed ? ['diff-del', '- '] : ['diff-ctx', '  ']
          return part.value.replace(/\n$/, '').split('\n').map((line) => ({ kind, text: mark + line }))
        }),
  )
</script>

{#if name === 'Bash'}
  <Rich code={str(input.command)} lang="bash" />
{:else if name === 'Edit'}
  <pre class="diff">{#each diff as line, i (i)}<div class={line.kind}>{line.text}</div>{/each}</pre>
{:else if name === 'Write'}
  <Rich code={str(input.content)} lang={langOf(str(input.file_path))} />
{:else if name === 'mcp__terminal__send_to_terminal'}
  <pre class="tool-text">{terminalSteps(input)}</pre>
{:else if name === 'Agent' || name === 'Task'}
  <pre class="tool-text">{str(input.prompt)}</pre>
{:else if !['Read', 'Glob', 'Grep', 'WebSearch'].includes(name)}
  <pre class="tool-text">{JSON.stringify(input, null, 2)}</pre>
{/if}
