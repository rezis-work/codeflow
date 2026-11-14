export function alpha(): string {
  return 'a';
}

export function beta(): number {
  return 1;
}

export function direct(): string {
  return alpha();
}

function run(task: () => void): void {
  task();
}

export function higherOrder(): void {
  run(alpha);
}

export function pick(flag: boolean): string | number {
  const chosen = flag ? alpha : beta;
  return chosen();
}

export function computed(flag: boolean): string | number {
  const table = { alpha, beta };
  const key = flag ? 'alpha' : 'beta';
  return table[key]();
}

export interface Speaker {
  speak(): string;
}

export function shout<T extends Speaker>(value: T): string {
  return value.speak();
}

export class Person implements Speaker {
  speak(): string {
    return direct();
  }
}
