/** Short enough to send with every search, long enough to write an execute snippet. */
export const API_DOCS = [
  'graph.find({ name?, path?, kind?, query?, limit? }) -> functions. kind is function, method, route, file, or entry.',
  'fn.callers(hops?) and fn.callees(hops?) follow call edges. hops defaults to 1 and stops at 8.',
  'fn.source() is the function text from the last refresh, capped. fn.file and fn.line are its location. fn.signature is the first line.',
  'graph.pathBetween(a, b) is the shortest call path. a and b are a name, an id, or { name, path }.',
  'graph.impact(name | { name, path } | { targets, files, hops }) is the blast radius: transitive callers (default 3 hops, max 8), routes, tests, uncertain edges, and risk.low|medium|high.',
  'graph.entryPoints() lists routes, main, tests, and exported functions. graph.routes() lists detected HTTP routes.',
  'Write JavaScript or TypeScript that returns JSON. The snippet cannot use require, process, fs, import, or the network.',
].join('\n');
