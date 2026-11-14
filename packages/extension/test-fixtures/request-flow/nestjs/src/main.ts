export function bootstrap(app: { setGlobalPrefix(prefix: string): void }): void {
  app.setGlobalPrefix('api');
}
