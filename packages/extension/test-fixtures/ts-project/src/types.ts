export interface Named {
  name: string;
}

export interface Greeter extends Named {
  greet(): string;
}

export enum Level {
  Info,
  Warn,
}
