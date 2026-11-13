export function add(left, right) {
  return left + right;
}

export const double = (value) => value * 2;

export class Counter {
  constructor(start) {
    this.value = start;
  }

  inc() {
    this.value += 1;
    return this.value;
  }
}
