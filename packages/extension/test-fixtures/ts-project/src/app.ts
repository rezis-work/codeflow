import type { Greeter } from './types';
import { format } from '@app/lib/util';

export class App implements Greeter {
  constructor(public name: string) {}

  greet(): string {
    return format(this.name);
  }

  start(): string {
    return this.greet();
  }
}

export class SpecialApp extends App {
  override start(): string {
    return super.start();
  }
}
