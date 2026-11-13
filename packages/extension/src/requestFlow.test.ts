import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createGraphStore } from '@codeflow/shared';
import type { CodeGraph, EntryPoint, FileFragment } from '@codeflow/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { discoverProjects } from './analyzers/typescript/discover';
import { openAnalysisSession } from './analyzers/typescript/analyzer';
import { collectTypeScriptDataHits } from './analyzers/typescript/dataHits';
import { pathToFileUri } from './analyzers/typescript/uri';
import { openRustSession } from './analyzers/rust/analyzer';
import type { CargoRunner } from './analyzers/rust/discover';
import { discoverRustWorkspace } from './analyzers/rust/discover';
import { ensureRustParser } from './analyzers/rust/ensureParser';
import { collectRustReports } from './analyzers/rust/routes';
import { getEntryCatalog } from './entryCatalog';
import { buildRequestFlow } from './requestFlowView';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test-fixtures/request-flow',
);

const missingCargo: CargoRunner = () => ({
  ok: false,
  missing: true,
  message: 'cargo is not installed',
});

beforeAll(async () => {
  await ensureRustParser();
});

afterEach(() => {
  getEntryCatalog().clear();
});

function analyzeTypeScript(root: string): { fragments: FileFragment[]; entries: EntryPoint[] } {
  const discovered = discoverProjects(root, { maxFiles: 100 });
  const sessions = discovered.projects.map((project) => openAnalysisSession(project));
  const fragments = sessions.flatMap((session) => session.analyze());
  const entries = sessions.flatMap((session) =>
    session.entryReports().flatMap((report) => [...report.entries]),
  );
  const hits = sessions.flatMap((session) => session.entryReports());
  for (const report of hits) {
    getEntryCatalog().replace(report);
  }
  for (const session of sessions) {
    session.dispose();
  }
  return { fragments, entries };
}

function analyzeRust(root: string): { fragments: FileFragment[]; entries: EntryPoint[] } {
  const discovered = discoverRustWorkspace(root, { maxFiles: 100 }, missingCargo);
  const session = openRustSession(discovered);
  const fragments = session.analyze();
  const entries = session.entryReports().flatMap((report) => [...report.entries]);
  for (const report of session.entryReports()) {
    getEntryCatalog().replace(report);
  }
  session.dispose();
  return { fragments, entries };
}

function routeView(entries: readonly EntryPoint[]) {
  return [...entries]
    .map((entry) => ({
      framework: entry.framework,
      kind: entry.entryKind,
      method: entry.method,
      path: entry.path,
      handler: entry.handlerName,
      package: entry.packageName,
      unresolved: entry.unresolved,
      uncertain: entry.uncertain === true,
      detail: entry.detail ?? '',
    }))
    .sort((left, right) =>
      `${left.method} ${left.path} ${left.handler}`.localeCompare(
        `${right.method} ${right.path} ${right.handler}`,
      ),
    );
}

function traceView(graph: CodeGraph) {
  const nameOf = (id: string) => graph.nodes.find((node) => node.id === id)?.name ?? id;
  return {
    nodes: graph.nodes
      .map((node) => ({ kind: node.kind, name: node.name, note: node.note ?? '' }))
      .sort((left, right) =>
        `${left.kind} ${left.name}`.localeCompare(`${right.kind} ${right.name}`),
      ),
    edges: graph.edges
      .map((edge) => ({
        kind: edge.kind,
        from: nameOf(edge.from),
        to: nameOf(edge.to),
        uncertain: edge.uncertain === true,
        detail: edge.detail ?? '',
      }))
      .sort((left, right) =>
        `${left.kind} ${left.from} ${left.to} ${left.detail}`.localeCompare(
          `${right.kind} ${right.from} ${right.to} ${right.detail}`,
        ),
      ),
  };
}

function trace(
  entries: readonly EntryPoint[],
  fragments: readonly FileFragment[],
  method: string,
  routePath: string,
) {
  const entry = entries.find((item) => item.method === method && item.path === routePath);
  if (!entry) {
    throw new Error(
      `Missing ${method} ${routePath}. Saw ${entries.map((item) => `${item.method} ${item.path}`).join(', ')}`,
    );
  }
  const graph = buildRequestFlow({
    store: createGraphStore(fragments),
    entry,
    hits: getEntryCatalog().hits(),
    callDepth: 2,
    maxNodes: 300,
  });
  return traceView(graph);
}

describe('request flow fixtures', () => {
  it('lists Next.js routes and traces GET /api/pets to prisma', () => {
    const analyzed = analyzeTypeScript(path.join(fixtures, 'next-app'));
    expect(routeView(analyzed.entries)).toMatchSnapshot('next routes');
    expect(trace(analyzed.entries, analyzed.fragments, 'GET', '/api/pets')).toMatchSnapshot(
      'next trace',
    );
  });

  it('lists NestJS routes and traces GET /api/pets through an uncertain provider', () => {
    const analyzed = analyzeTypeScript(path.join(fixtures, 'nestjs'));
    expect(routeView(analyzed.entries)).toMatchSnapshot('nest routes');
    const graph = trace(analyzed.entries, analyzed.fragments, 'GET', '/api/pets');
    expect(graph.edges.some((edge) => edge.uncertain)).toBe(true);
    expect(graph).toMatchSnapshot('nest trace');
  });

  it('lists Axum routes and traces GET /pets to sqlx', () => {
    const analyzed = analyzeRust(path.join(fixtures, 'axum-app'));
    expect(routeView(analyzed.entries)).toMatchSnapshot('axum routes');
    const graph = trace(analyzed.entries, analyzed.fragments, 'GET', '/pets');
    expect(graph.edges.some((edge) => edge.uncertain)).toBe(true);
    expect(graph).toMatchSnapshot('axum trace');
  });

  it('lists Actix routes and traces GET /api/pets to diesel', () => {
    const analyzed = analyzeRust(path.join(fixtures, 'actix-app'));
    expect(routeView(analyzed.entries)).toMatchSnapshot('actix routes');
    expect(trace(analyzed.entries, analyzed.fragments, 'GET', '/api/pets')).toMatchSnapshot(
      'actix trace',
    );
  });
});

describe('data-layer detectors', () => {
  it('names tables for the TypeScript clients', () => {
    const source = ts.createSourceFile(
      'hits.ts',
      `
        declare const prisma: any;
        declare const db: any;
        declare const repository: any;
        declare const manager: any;
        declare const User: any;
        declare const knex: any;
        declare function sql(text: TemplateStringsArray): unknown;
        declare const pool: any;
        export function read() {
          prisma.user.findMany();
          db.select().from(users);
          db.query.accounts.findFirst();
          repository.find();
          manager.save(row);
          User.findOne();
          db.selectFrom('posts');
          knex('jobs');
          knex.from('tasks');
          sql\`select * from notes\`;
          pool.query('select * from sessions');
          fetch('https://example.test/pets');
          fetch(url);
          this.usersRepository.find();
          this.usersRepository.delete(id);
          NestFactory.create(AppModule);
          request(app).delete('/users/1');
        }
      `,
      ts.ScriptTarget.ES2022,
      true,
    );
    const hits = collectTypeScriptDataHits(source, pathToFileUri('hits.ts')).map((hit) => ({
      library: hit.library,
      operation: hit.operation,
      target: hit.target ?? '',
      external: hit.external === true,
      uncertain: hit.uncertain === true,
    }));
    expect(hits).toMatchSnapshot('typescript sinks');
  });

  it('names tables for the Rust clients', () => {
    const reports = collectRustReports([
      {
        filePath: path.join(fixtures, 'snippet.rs'),
        content: `
          fn read(client: &(), redis: &()) {
            sqlx::query!("select id from pets").fetch_one(&());
            sqlx::query("select id from other");
            pets::table.load(&());
            pets::table.execute(&());
            pet::Entity::find().one(&());
            user::ActiveModel.save(&());
            client.query("select id from sessions", &[]);
            redis.get("session");
            redis::cmd("PING");
          }
        `,
        packageName: 'snippet',
      },
    ]);
    const hits = (reports[0]?.hits ?? []).map((hit) => ({
      library: hit.library,
      operation: hit.operation,
      target: hit.target ?? '',
    }));
    expect(hits).toMatchSnapshot('rust sinks');
  });
});
