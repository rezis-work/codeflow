import { boot } from './service';
import { format } from './lib';

export function main(): string {
  return format(boot());
}

export function extra(): string {
  return 'extra';
}
