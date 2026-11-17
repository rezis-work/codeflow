<script lang="ts">
  let { text, label }: { text: string; label: string } = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      copied = false;
      return;
    }
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
    }, 1600);
  }
</script>

<button type="button" class="copy" onclick={copy} aria-label={label}>
  {copied ? 'Copied' : 'Copy'}
</button>
