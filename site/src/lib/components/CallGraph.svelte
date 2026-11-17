<svg
  viewBox="0 0 520 250"
  role="img"
  aria-label="Call graph of greet calling format. A runtime trace then numbers greet 1 and format 2."
>
  <defs>
    <marker
      id="cg-arrow"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M0 0 L10 5 L0 10 z" class="arrow-head" />
    </marker>
  </defs>
  <line
    class="draw edge"
    pathLength="1"
    x1="188"
    y1="104"
    x2="324"
    y2="104"
    marker-end="url(#cg-arrow)"
    style="animation-delay: 0.45s"
  />
  <line class="trace-line" x1="188" y1="104" x2="312" y2="104" />
  <g class="node" style="animation-delay: 0.05s">
    <rect x="24" y="68" width="164" height="72" rx="16" />
    <text class="node-title" x="40" y="98">greet</text>
    <text class="node-meta" x="40" y="122">function · TS</text>
  </g>
  <g class="node" style="animation-delay: 0.28s">
    <rect x="328" y="68" width="164" height="72" rx="16" />
    <text class="node-title" x="344" y="98">format</text>
    <text class="node-meta" x="344" y="122">function · TS</text>
  </g>
  <g class="badge" style="animation-delay: 1.55s">
    <circle cx="48" cy="68" r="14" />
    <text x="48" y="73">1</text>
  </g>
  <g class="badge" style="animation-delay: 1.95s">
    <circle cx="352" cy="68" r="14" />
    <text x="352" y="73">2</text>
  </g>
</svg>
