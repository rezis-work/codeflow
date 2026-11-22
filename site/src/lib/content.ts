export const marketplaceUrl =
  'https://marketplace.visualstudio.com/items?itemName=rezis-work.rezis-codeflow';
export const openVsxUrl = 'https://open-vsx.org/extension/rezis-work/rezis-codeflow';
export const repoUrl = 'https://github.com/rezis-work/codeflow';
export const releaseUrl = 'https://github.com/rezis-work/codeflow/releases/latest';
export const licenseUrl = 'https://github.com/rezis-work/codeflow/blob/main/LICENSE';

export const cliInstall = 'code --install-extension rezis-work.rezis-codeflow';
export const extInstall = 'ext install rezis-work.rezis-codeflow';

export const title = 'Rezis CodeFlow — see how your code runs, beside the code';

export const description =
  'CodeFlow draws how your code runs, beside the code. Call graphs, flowcharts, sequence diagrams, Rust trait maps, and request traces for TypeScript, JavaScript, Rust, and Python. Analysis stays on your machine. There is no telemetry.';

export const agentFeatures = [
  {
    title: 'MCP server',
    body: 'A stdio server for the call graph. Agents search it, or run a short read-only snippet in a sandbox with no filesystem and no network.',
    href: '/docs/agents',
  },
  {
    title: 'Impact check',
    body: 'Transitive callers, affected routes, likely tests, and a low, medium, or high risk score for a function or the current diff.',
    href: '/docs/cli#codeflow-impact',
  },
  {
    title: 'Agent context',
    body: 'A managed architecture map in AGENTS.md, and optionally Cursor and Claude files. Auto-update after save is off until you turn it on.',
    href: '/docs/workflows#keep-agents-md-up-to-date-in-ci',
  },
  {
    title: 'Review agent changes',
    body: 'A before-and-after call graph. Flags new cycles, newly dead code, route changes, signature changes, and duplicate helpers.',
    href: '/docs/workflows#check-what-an-ai-agent-changed-before-you-merge',
  },
  {
    title: 'Task planner',
    body: 'Ranks the smallest set of functions to read for a task, with a reason on each line and a prompt an agent can paste.',
    href: '/docs/workflows#plan-a-task-for-an-agent',
  },
  {
    title: 'Duplicate checker',
    body: 'Warns when new code repeats a helper, and writes a fix prompt that names the function to reuse.',
    href: '/docs/workflows#stop-an-agent-from-duplicating-helpers',
  },
] as const;

export const features = [
  {
    title: 'Call graph',
    body: 'The neighbourhood of the symbol under the cursor, two calls out in every direction. Certain calls are solid. Inferred and uncertain calls are dashed. Click a node to open it. The cursor follows.',
  },
  {
    title: 'Control-flow flowcharts',
    body: 'Decisions, switches, loops, try / catch / finally, early returns, await, and yield. Rust also draws match, loop, ?, and unwrap / expect. Python also draws elif, match / case, loop else, with, and assert. A Flow button on a function or method opens the same view.',
  },
  {
    title: 'Sequence diagrams',
    body: 'Function calls, or a request, as a timeline. Lifelines group by file, by class, impl, or struct, or by module or crate. Uncertain calls stay dashed.',
  },
  {
    title: 'Rust trait maps',
    body: 'A trait with its supertraits, every workspace impl, and the methods those impls override or inherit. On a type, the traits it implements. dyn Trait, generic bounds, and impl Trait calls are dashed.',
  },
  {
    title: 'Request flow',
    body: 'Next.js, NestJS, Axum, and Actix routes through the handler and the calls below it. The side panel lists entry points. Detection is static. Nothing is executed.',
  },
  {
    title: 'File dependencies',
    body: 'Import edges of the current file, and the same idea for a file in the explorer or the files in a folder plus one import hop.',
  },
  {
    title: 'Runtime trace',
    body: 'Start and Stop while debugging. Node debugger, CodeLLDB, and debugpy. Symbols, call edges, and flowchart blocks are numbered in visit order. Clear removes the overlay. Nothing leaves the machine.',
  },
  {
    title: 'Export',
    body: 'PNG, SVG, or Mermaid from any diagram, or copy Mermaid. Uncertain edges stay dashed.',
  },
] as const;

export const steps = [
  {
    title: 'Install',
    body: 'Install from the VS Code Marketplace or Open VSX. The publisher is rezis-work, the extension is rezis-codeflow, and the display name is Rezis CodeFlow.',
  },
  {
    title: 'Open a project',
    body: 'Open a folder in VS Code or Cursor. TypeScript, JavaScript, Rust, and Python are analyzed on your machine. Nothing is uploaded.',
  },
  {
    title: 'Run the first command',
    body: 'Open a supported file and run CodeFlow: Show Flow for Symbol at Cursor. Right-click, or press Ctrl+Alt+F (Cmd+Alt+F on macOS).',
  },
] as const;

export const faqs = [
  {
    q: 'Does any of this leave my machine?',
    a: 'No. Analysis is local. There is no telemetry client in the extension or the diagram view. The diagram is a webview with a nonce content security policy and no remote load. The analysis cache stays in this window’s local storage.',
  },
  {
    q: 'Where do I install it?',
    a: 'VS Code uses the Marketplace. Cursor uses Open VSX. The extension id is rezis-work.rezis-codeflow. You can also install the .vsix from the latest GitHub Release: Extensions, then Install from VSIX. From a terminal: code --install-extension rezis-work.rezis-codeflow. Inside the editor: ext install rezis-work.rezis-codeflow.',
  },
  {
    q: 'Which languages does it draw?',
    a: 'TypeScript, JavaScript, Rust, and Python, including .ts, .tsx, .js, .jsx, .mts, .cts, and .py. The editor language has to be one of those. Trait map is Rust only. Path aliases and npm, yarn, and pnpm workspaces are followed. Rust uses tree-sitter, and cargo metadata when cargo is on PATH. Python uses tree-sitter and does not need a Python runtime. .pyi stubs are not analyzed.',
  },
  {
    q: 'What does a runtime trace record?',
    a: 'Stops the debugger already made: breakpoints and steps, not every instruction. It watches the Node debugger (node, pwa-node, node2, node-terminal), CodeLLDB (lldb, codelldb), and debugpy (debugpy, python). It keeps the first TypeScript, JavaScript, Rust, or Python frame outside node_modules, site-packages, and virtualenvs. Recording starts only when you run CodeFlow: Start Runtime Trace. Clear removes the numbers. Stops are ignored until a trace is started.',
  },
  {
    q: 'Does request flow run my server?',
    a: 'No. Routes are detected from source. Next.js covers App Router route handlers, Pages Router pages/api, middleware.ts, and use server actions. NestJS covers controller methods and a string setGlobalPrefix. Axum covers route, method chains, nest, and merge. Actix covers method attributes, route, web::resource, scopes, App services, and configure. A computed path is listed as unresolved path. Data-layer sinks are name matches, not a live database. FastAPI, Flask, and Django routes are not detected.',
  },
  {
    q: 'What do I need installed?',
    a: 'VS Code 1.90 or newer, or a current Cursor. For Rust crate names, cargo on PATH. Without it, CodeFlow reads Cargo.toml and src/ and shows a warning. rust-analyzer is optional and is not installed by CodeFlow. Python diagrams do not need Python installed. Node.js 22 or newer is only needed if you build from source.',
  },
  {
    q: 'Why are some edges dashed?',
    a: 'A solid edge is a certain workspace call. A dashed edge is inferred or uncertain: TypeScript when the checker does not name one workspace function, Rust for dyn Trait, a generic bound, or impl Trait, and Python for a method call on an unknown receiver or getattr. Dashed edges stay dashed in PNG, SVG, and Mermaid export.',
  },
] as const;

export const shots = [
  {
    src: '/gallery/function-call-sequence.png',
    width: 480,
    height: 420,
    alt: "A function's calls as a sequence.",
  },
  {
    src: '/gallery/control-flow-branch.png',
    width: 1200,
    height: 800,
    alt: 'Control flow of branch, with caller and callee counts in the editor.',
  },
  {
    src: '/gallery/nestjs-request-sequence.png',
    width: 1464,
    height: 860,
    alt: 'NestJS GET /api/pets as a sequence.',
  },
  {
    src: '/gallery/lovepet-route-handle.png',
    width: 1680,
    height: 1050,
    alt: 'Call graph around a TypeScript route handler.',
  },
] as const;
