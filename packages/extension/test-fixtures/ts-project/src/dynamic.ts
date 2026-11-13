function alpha(): string {
  return 'a';
}

function beta(): number {
  return 1;
}

export function pick(flag: boolean): string | number {
  const fn = flag ? alpha : beta;
  return fn();
}

export function callAny(callback: any): void {
  callback();
}

export function callComputed(table: Record<string, () => string>, key: string): string {
  return table[key]();
}

export const loose: any = function looseImpl(): number {
  return 1;
};

export function callLoose(): number {
  return loose();
}
