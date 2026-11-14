/**
 * Data-layer calls that end a request trace.
 *
 * The table is the extension point. A new library is a row whose `call`
 * style the matcher already understands (`member`, `function`, `tagged`,
 * `macro`, `path`, `method`). Rows are matched in order; the first hit wins.
 */

export const DATA_CALL_STYLES = [
  'member',
  'function',
  'tagged',
  'macro',
  'path',
  'method',
] as const;
export type DataCallStyle = (typeof DATA_CALL_STYLES)[number];

export const DATA_TARGETS = [
  'none',
  'previous-member',
  'arg',
  'sql-arg',
  'sql-table',
  'table-in-chain',
  'receiver-name',
  'url',
] as const;
export type DataTarget = (typeof DATA_TARGETS)[number];

export interface DataDetector {
  readonly id: string;
  readonly language: 'ts' | 'rust';
  readonly library: string;
  readonly call: DataCallStyle;
  readonly target: DataTarget;
  readonly methods?: readonly string[];
  readonly names?: readonly string[];
  /** A chain segment that must appear (`prisma`, `query`, `sqlx`, `table`). */
  readonly requireSegment?: string;
  /** Skip the row when the chain contains this segment. */
  readonly excludeSegment?: string;
  /** The receiver of a member call must itself be a call to this method (`select().from`). */
  readonly receiverMethod?: string;
  /** Receiver name must match this regular expression source. */
  readonly receiverPattern?: string;
  /** Receiver name must not match this regular expression source. */
  readonly rejectReceiverPattern?: string;
  readonly external?: boolean;
}

export const DATA_DETECTORS: readonly DataDetector[] = [
  {
    id: 'prisma',
    language: 'ts',
    library: 'prisma',
    call: 'member',
    methods: [
      'findMany',
      'findFirst',
      'findUnique',
      'findUniqueOrThrow',
      'findFirstOrThrow',
      'create',
      'createMany',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
      'upsert',
      'count',
      'aggregate',
      'groupBy',
    ],
    requireSegment: 'prisma',
    target: 'previous-member',
  },
  {
    id: 'prisma-raw',
    language: 'ts',
    library: 'prisma',
    call: 'member',
    methods: ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'],
    requireSegment: 'prisma',
    target: 'sql-arg',
  },
  {
    id: 'drizzle-query',
    language: 'ts',
    library: 'drizzle',
    call: 'member',
    methods: ['findMany', 'findFirst'],
    requireSegment: 'query',
    target: 'previous-member',
  },
  {
    id: 'drizzle-crud',
    language: 'ts',
    library: 'drizzle',
    call: 'member',
    methods: ['select', 'insert', 'update', 'delete'],
    receiverPattern: '.+',
    rejectReceiverPattern: 'repository|manager|Repository|EntityManager',
    target: 'arg',
  },
  {
    id: 'drizzle-from',
    language: 'ts',
    library: 'drizzle',
    call: 'member',
    methods: ['from'],
    receiverMethod: 'select',
    target: 'arg',
  },
  {
    id: 'typeorm',
    language: 'ts',
    library: 'typeorm',
    call: 'member',
    methods: [
      'find',
      'findOne',
      'findOneBy',
      'findBy',
      'save',
      'remove',
      'delete',
      'update',
      'createQueryBuilder',
      'query',
    ],
    receiverPattern: 'repository|manager|Repository|EntityManager',
    target: 'arg',
  },
  {
    id: 'typeorm-get',
    language: 'ts',
    library: 'typeorm',
    call: 'function',
    names: ['getRepository', 'getTreeRepository'],
    target: 'arg',
  },
  {
    id: 'mongoose',
    language: 'ts',
    library: 'mongoose',
    call: 'member',
    methods: [
      'find',
      'findOne',
      'findById',
      'create',
      'insertMany',
      'updateOne',
      'updateMany',
      'deleteOne',
      'deleteMany',
      'aggregate',
      'countDocuments',
    ],
    receiverPattern: '^[A-Z]',
    rejectReceiverPattern: 'Factory$',
    excludeSegment: 'repository',
    target: 'receiver-name',
  },
  {
    id: 'kysely',
    language: 'ts',
    library: 'kysely',
    call: 'member',
    methods: ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom'],
    target: 'arg',
  },
  {
    id: 'knex-call',
    language: 'ts',
    library: 'knex',
    call: 'function',
    names: ['knex'],
    target: 'arg',
  },
  {
    id: 'knex-from',
    language: 'ts',
    library: 'knex',
    call: 'member',
    methods: ['from', 'into', 'table'],
    requireSegment: 'knex',
    target: 'arg',
  },
  {
    id: 'sql-tag',
    language: 'ts',
    library: 'sql',
    call: 'tagged',
    names: ['sql'],
    target: 'sql-table',
  },
  {
    id: 'pg',
    language: 'ts',
    library: 'pg',
    call: 'member',
    methods: ['query'],
    receiverPattern: '^(pool|client|sql)$',
    target: 'sql-arg',
  },
  {
    id: 'fetch',
    language: 'ts',
    library: 'fetch',
    call: 'function',
    names: ['fetch'],
    target: 'url',
    external: true,
  },
  {
    id: 'sqlx-macro',
    language: 'rust',
    library: 'sqlx',
    call: 'macro',
    names: ['query', 'query_as', 'query_scalar', 'query_unchecked', 'query_as_unchecked'],
    target: 'sql-table',
  },
  {
    id: 'sqlx-path',
    language: 'rust',
    library: 'sqlx',
    call: 'path',
    names: ['query', 'query_as', 'query_scalar'],
    requireSegment: 'sqlx',
    target: 'sql-table',
  },
  {
    id: 'diesel',
    language: 'rust',
    library: 'diesel',
    call: 'method',
    methods: ['load', 'get_result', 'get_results'],
    target: 'table-in-chain',
  },
  {
    id: 'diesel-execute',
    language: 'rust',
    library: 'diesel',
    call: 'method',
    methods: ['execute'],
    requireSegment: 'table',
    target: 'table-in-chain',
  },
  {
    id: 'sea-orm-find',
    language: 'rust',
    library: 'sea-orm',
    call: 'path',
    names: ['find', 'find_by_id'],
    requireSegment: 'Entity',
    target: 'previous-member',
  },
  {
    id: 'sea-orm-save',
    language: 'rust',
    library: 'sea-orm',
    call: 'method',
    methods: ['save', 'insert'],
    requireSegment: 'ActiveModel',
    target: 'previous-member',
  },
  {
    id: 'sqlx-fetch',
    language: 'rust',
    library: 'sqlx',
    call: 'method',
    methods: ['fetch', 'fetch_one', 'fetch_all', 'fetch_optional', 'fetch_many'],
    excludeSegment: 'table',
    target: 'sql-table',
  },
  {
    id: 'tokio-postgres',
    language: 'rust',
    library: 'tokio-postgres',
    call: 'method',
    methods: ['query', 'execute', 'batch_execute'],
    requireSegment: 'client',
    target: 'sql-arg',
  },
  {
    id: 'redis',
    language: 'rust',
    library: 'redis',
    call: 'method',
    methods: ['get', 'set', 'del', 'hget', 'hset'],
    requireSegment: 'redis',
    target: 'arg',
  },
  {
    id: 'redis-cmd',
    language: 'rust',
    library: 'redis',
    call: 'path',
    names: ['cmd'],
    requireSegment: 'redis',
    target: 'arg',
  },
];

const DETECTOR_IDS = new Set(DATA_DETECTORS.map((detector) => detector.id));

export function isKnownDetector(id: string): boolean {
  return DETECTOR_IDS.has(id);
}
