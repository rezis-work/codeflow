#!/usr/bin/env node
/**
 * `codeflow export` writes the agent file. `codeflow mcp` starts the MCP server.
 * `codeflow impact` prints the blast radius of a function or the current diff.
 * `codeflow context` refreshes the managed architecture map.
 * `codeflow review` diffs the call graph before and after a change.
 * `codeflow plan` ranks functions to read for a task.
 * Export is the bundled CLI. The MCP server, impact, context, review, and plan commands are built separately.
 */

const argv = process.argv.slice(2);

if (argv[0] === 'mcp') {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'codeflow mcp [--root dir] [--max-files n]',
        '',
        'Start the CodeFlow MCP server on stdio. Build it first with',
        'npm run build -w @codeflow/mcp',
      ].join('\n'),
    );
    process.exit(0);
  }
  try {
    const loaded = await import(new URL('../../mcp/dist/cli.js', import.meta.url));
    const code = await loaded.main(argv.slice(1));
    process.exitCode = code;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Could not start the CodeFlow MCP server.',
    );
    console.error('Build it with: npm run build -w @codeflow/mcp');
    process.exitCode = 1;
  }
} else if (argv[0] === 'impact') {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'codeflow impact <path#function | file | name>... [--hops 3] [--diff] [--base <ref>] [--json] [--md]',
        '',
        'Build it first with npm run build -w @codeflow/mcp',
      ].join('\n'),
    );
    process.exit(0);
  }
  try {
    const loaded = await import(new URL('../../mcp/dist/impactCli.js', import.meta.url));
    const code = await loaded.main(argv.slice(1));
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not run codeflow impact.');
    console.error('Build it with: npm run build -w @codeflow/mcp');
    process.exitCode = 1;
  }
} else if (argv[0] === 'context') {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'codeflow context [--targets agents,cursor,claude] [--budget 1500] [--check]',
        '',
        'Write the architecture map into AGENTS.md. cursor and claude are optional targets.',
        '--check exits 1 when a target is stale and writes nothing.',
        'Build it first with npm run build -w @codeflow/mcp',
      ].join('\n'),
    );
    process.exit(0);
  }
  try {
    const loaded = await import(new URL('../../mcp/dist/contextCli.js', import.meta.url));
    const code = await loaded.main(argv.slice(1));
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not run codeflow context.');
    console.error('Build it with: npm run build -w @codeflow/mcp');
    process.exitCode = 1;
  }
} else if (argv[0] === 'review') {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'codeflow review [--base <ref>] [--json] [--md] [--fail-on cycles,dead,routes,signatures]',
        '',
        'Diff the call graph. With no --base, compare the working tree with HEAD.',
        'Build it first with npm run build -w @codeflow/mcp',
      ].join('\n'),
    );
    process.exit(0);
  }
  try {
    const loaded = await import(new URL('../../mcp/dist/reviewCli.js', import.meta.url));
    const code = await loaded.main(argv.slice(1));
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not run codeflow review.');
    console.error('Build it with: npm run build -w @codeflow/mcp');
    process.exitCode = 1;
  }
} else if (argv[0] === 'plan') {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'codeflow plan "<task>" [--focus path] [--budget 12] [--json] [--md]',
        '',
        'Rank functions to read first. Markdown is the default.',
        'Build it first with npm run build -w @codeflow/mcp',
      ].join('\n'),
    );
    process.exit(0);
  }
  try {
    const loaded = await import(new URL('../../mcp/dist/planCli.js', import.meta.url));
    const code = await loaded.main(argv.slice(1));
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not run codeflow plan.');
    console.error('Build it with: npm run build -w @codeflow/mcp');
    process.exitCode = 1;
  }
} else {
  try {
    const loaded = await import('../dist/exportCli.js');
    process.exitCode = await loaded.main(argv);
  } catch (error) {
    const missing =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_MODULE_NOT_FOUND';
    console.error(error instanceof Error ? error.message : 'Could not run codeflow export.');
    if (missing) {
      console.error('Build it with: npm run build -w @codeflow/pr');
    }
    process.exitCode = 1;
  }
}
