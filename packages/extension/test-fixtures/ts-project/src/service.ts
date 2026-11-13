import { App } from './app';
import helper from './helper';
import { featureFlag } from './features';

export function boot(): string {
  function announce(value: string): string {
    return value;
  }
  if (!featureFlag()) {
    return '';
  }
  const app = new App('demo');
  return announce(helper(app.start()));
}

export const run = (value: string): string => value;
