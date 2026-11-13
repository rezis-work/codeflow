import leftpad from 'leftpad';

export function pad(value: string): string {
  return leftpad(value, 4);
}
