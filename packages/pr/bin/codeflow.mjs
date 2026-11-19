#!/usr/bin/env node
/**
 * `codeflow export` writes the agent file. `codeflow mcp` starts the MCP server.
 * `codeflow impact` prints the blast radius of a function or the current diff.
 * Export is the bundled CLI. The MCP server and impact command are built separately.
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
