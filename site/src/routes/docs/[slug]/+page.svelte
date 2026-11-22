<script lang="ts">
  import DocsArticle from '#lib/components/DocsArticle.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<DocsArticle page={data.page} origin={data.origin} />