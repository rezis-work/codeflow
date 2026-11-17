<svg
  viewBox="0 0 420 240"
  role="img"
  aria-label="Trait map: Shape extends Draw, and Circle implements Shape with area."
>
  <defs>
    <marker
      id="tr-arrow"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path d="M0 0 L10 5 L0 10 z" class="arrow-head" />
    </marker>
  </defs>
  <g class="node" style="animation-delay: 0.05s">
    <rect x="148" y="16" width="124" height="52" rx="14" />
    <text class="node-title" x="210" y="38" text-anchor="middle">Draw</text>
    <text class="node-meta" x="210" y="56" text-anchor="middle">trait</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="210"
    y1="68"
    x2="210"
    y2="108"
    marker-end="url(#tr-arrow)"
    style="animation-delay: 0.3s"
  />
  <text class="edge-label" x="218" y="94">supertrait</text>
  <g class="node" style="animation-delay: 0.45s">
    <rect x="140" y="108" width="140" height="52" rx="14" />
    <text class="node-title" x="210" y="130" text-anchor="middle">Shape</text>
    <text class="node-meta" x="210" y="148" text-anchor="middle">trait</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="140"
    y1="134"
    x2="78"
    y2="168"
    marker-end="url(#tr-arrow)"
    style="animation-delay: 0.7s"
  />
  <text class="edge-label" x="86" y="128">impl</text>
  <g class="node" style="animation-delay: 0.85s">
    <rect x="16" y="168" width="140" height="52" rx="14" />
    <text class="node-title" x="86" y="190" text-anchor="middle">Circle</text>
    <text class="node-meta" x="86" y="208" text-anchor="middle">area</text>
  </g>
</svg>
