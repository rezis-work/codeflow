import { add, Counter, double } from './math.js';

export function main() {
  const counter = new Counter(1);
  return add(counter.inc(), double(2));
}
