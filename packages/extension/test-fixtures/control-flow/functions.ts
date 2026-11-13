// Control-flow fixtures. This comment is outside every function.
export function branch(user: string | null, admin: boolean): string {
  /* cf:branch */
  if (user == null) {
    return 'missing';
  } else if (admin) {
    return 'admin';
  } else {
    return user;
  }
}

export function nestedIfs(a: boolean, b: boolean): void {
  /* cf:nestedIfs */
  if (a) {
    if (b) {
      left();
    }
    mid();
  }
  end();
}

function left(): void {}
function mid(): void {}
function end(): void {}

export function classify(n: number): string {
  /* cf:classify */
  switch (n) {
    case 1:
    case 2:
      return 'low';
    case 3:
      hit();
    default:
      return 'other';
  }
}

function hit(): void {}

export function loops(items: string[], obj: Record<string, number>): number {
  /* cf:loops */
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i] === 'skip') {
      continue;
    }
    total += i;
  }
  for (const item of items) {
    total += item.length;
  }
  for (const key in obj) {
    total += obj[key] ?? 0;
  }
  let n = items.length;
  while (n > 0) {
    n -= 1;
    if (n === 1) {
      break;
    }
  }
  do {
    n += 1;
  } while (n < 2);
  return total;
}

export function labeledBreak(): number {
  /* cf:labeledBreak */
  let hit = 0;
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j === 1) {
        break outer;
      }
      hit += 1;
    }
  }
  return hit;
}

export function attempt(run: () => number): number {
  /* cf:attempt */
  try {
    return run();
  } catch (error) {
    report(error);
    return 0;
  } finally {
    done();
  }
}

export function finallyWins(): number {
  /* cf:finallyWins */
  try {
    return 1;
  } finally {
    return 2;
  }
}

function report(_error: unknown): void {}
function done(): void {}

export function fail(message: string): never {
  /* cf:fail */
  throw new Error(message);
}

export function early(n: number): number {
  /* cf:early */
  if (n < 0) {
    return 0;
  }
  if (n === 0) {
    return 1;
  }
  return n;
}

export async function load(id: string): Promise<string> {
  /* cf:load */
  const user = await fetchUser(id);
  const posts = await fetchPosts(user);
  return posts;
}

async function fetchUser(id: string): Promise<string> {
  return id;
}
async function fetchPosts(user: string): Promise<string> {
  return user;
}

export async function each(ids: string[]): Promise<void> {
  /* cf:each */
  for (const id of ids) {
    await send(id);
  }
}

async function send(_id: string): Promise<void> {}

export function* pages(n: number): Generator<number> {
  /* cf:pages */
  for (let i = 0; i < n; i++) {
    yield i;
  }
}

export const double = (n: number): number => n * 2;

export const sign = (n: number): number => (n > 0 ? /* cf:sign */ 1 : n < 0 ? -1 : 0);

export class Box {
  public constructor(private n: number) {
    /* cf:constructor */
    this.n = n;
  }

  public get size(): number {
    /* cf:size */
    return this.n;
  }

  public set size(value: number) {
    /* cf:setSize */
    this.n = value;
  }

  public area(): number {
    /* cf:area */
    if (this.n < 0) {
      return 0;
    }
    return this.n * this.n;
  }
}

export function project(items: number[]): number[] {
  /* cf:project */
  const values = items.map((item) => {
    if (item < 0) {
      return 0;
    }
    return item;
  });
  return values;
}

export function dead(flag: boolean): number {
  /* cf:dead */
  if (flag) {
    return 1;
  }
  return 2;
  console.log('never');
}

export function light(user: { name?: string } | null): string {
  /* cf:light */
  const name = user?.name ?? 'anon';
  return name && name.length > 0 ? name : 'anon';
}
