export function greet(name: string): string {
  return format(name);
}

function format(name: string): string {
  return `Hello, ${name}`;
}
