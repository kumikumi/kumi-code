<script lang="ts">
  let { items }: { items: { text: string; status: string }[] } = $props()
</script>

<ul class="todos">
  {#each items as item, i (i)}
    <li class="todo {item.status}">
      <span class="todo-box">{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : ''}</span>
      <span class="todo-text">{item.text}</span>
    </li>
  {/each}
</ul>
