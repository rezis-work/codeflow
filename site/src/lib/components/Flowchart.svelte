<svg
  viewBox="0 0 400 430"
  role="img"
  aria-label="Flowchart of branch: if user is null return missing, else if admin return admin, else return user."
>
  <defs>
    <marker
      id="fc-arrow"
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
    <rect x="128" y="16" width="144" height="40" rx="20" />
    <text class="node-title" x="200" y="42" text-anchor="middle">branch</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="200"
    y1="56"
    x2="200"
    y2="88"
    marker-end="url(#fc-arrow)"
    style="animation-delay: 0.25s"
  />
  <g class="node" style="animation-delay: 0.35s">
    <polygon points="200,88 268,128 200,168 132,128" />
    <text class="node-title" x="200" y="124" text-anchor="middle">user ==</text>
    <text class="node-title" x="200" y="142" text-anchor="middle">null?</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="132"
    y1="128"
    x2="72"
    y2="128"
    style="animation-delay: 0.55s"
  />
  <line
    class="draw edge"
    pathLength="1"
    x1="72"
    y1="128"
    x2="72"
    y2="188"
    marker-end="url(#fc-arrow)"
    style="animation-delay: 0.7s"
  />
  <text class="edge-label" x="80" y="120">yes</text>
  <g class="node" style="animation-delay: 0.85s">
    <rect x="12" y="188" width="148" height="44" rx="12" />
    <text class="node-title" x="86" y="216" text-anchor="middle">return missing</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="200"
    y1="168"
    x2="200"
    y2="206"
    marker-end="url(#fc-arrow)"
    style="animation-delay: 0.7s"
  />
  <text class="edge-label" x="208" y="192">no</text>
  <g class="node" style="animation-delay: 0.9s">
    <polygon points="200,206 262,246 200,286 138,246" />
    <text class="node-title" x="200" y="251" text-anchor="middle">admin?</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="262"
    y1="246"
    x2="318"
    y2="246"
    style="animation-delay: 1.1s"
  />
  <line
    class="draw edge"
    pathLength="1"
    x1="318"
    y1="246"
    x2="318"
    y2="300"
    marker-end="url(#fc-arrow)"
    style="animation-delay: 1.2s"
  />
  <text class="edge-label" x="268" y="238">yes</text>
  <g class="node" style="animation-delay: 1.3s">
    <rect x="246" y="300" width="142" height="44" rx="12" />
    <text class="node-title" x="317" y="328" text-anchor="middle">return admin</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="200"
    y1="286"
    x2="200"
    y2="348"
    marker-end="url(#fc-arrow)"
    style="animation-delay: 1.25s"
  />
  <text class="edge-label" x="208" y="324">no</text>
  <g class="node" style="animation-delay: 1.4s">
    <rect x="116" y="348" width="168" height="44" rx="12" />
    <text class="node-title" x="200" y="376" text-anchor="middle">return user</text>
  </g>
</svg>
