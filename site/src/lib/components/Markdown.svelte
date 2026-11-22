<script lang="ts">
  import type { Block, Inline } from '../markdown.js';
  import CopyButton from './CopyButton.svelte';

  let { blocks }: { blocks: readonly Block[] } = $props();
</script>

{#snippet inline(nodes: readonly Inline[])}
  {#each nodes as node}
    {#if node.type === 'text'}
      {node.text}
    {:else if node.type === 'code'}
      <code>{node.text}</code>
    {:else if node.type === 'strong'}
      <strong>{@render inline(node.children)}</strong>
    {:else if node.type === 'link'}
      <a href={node.href}>{@render inline(node.children)}</a>
    {:else if node.type === 'image'}
      <img src={node.href} alt={node.alt} />
    {/if}
  {/each}
{/snippet}

<div class="prose">
  {#each blocks as block}
    {#if block.type === 'heading'}
      {#if block.depth === 2}
        <h2 id={block.id}>{@render inline(block.children)}</h2>
      {:else if block.depth === 3}
        <h3 id={block.id}>{@render inline(block.children)}</h3>
      {:else}
        <h4 id={block.id}>{@render inline(block.children)}</h4>
      {/if}
    {:else if block.type === 'paragraph'}
      <p>{@render inline(block.children)}</p>
    {:else if block.type === 'quote'}
      <blockquote><p>{@render inline(block.children)}</p></blockquote>
    {:else if block.type === 'list'}
      {#if block.ordered}
        <ol>
          {#each block.items as item}
            <li>{@render inline(item)}</li>
          {/each}
        </ol>
      {:else}
        <ul>
          {#each block.items as item}
            <li>{@render inline(item)}</li>
          {/each}
        </ul>
      {/if}
    {:else if block.type === 'code'}
      <div class="codeblock">
        <pre><code>{block.text}</code></pre>
        <CopyButton text={block.text} label="Copy code" />
      </div>
    {:else if block.type === 'table'}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              {#each block.headers as cell}
                <th>{@render inline(cell)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each block.rows as row}
              <tr>
                {#each row as cell}
                  <td>{@render inline(cell)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if block.type === 'hr'}
      <hr />
    {/if}
  {/each}
</div>
