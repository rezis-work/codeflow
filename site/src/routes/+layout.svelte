<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<div class="backdrop" aria-hidden="true"></div>
<a class="skip" href="#content">Skip to content</a>
{@render children()}
