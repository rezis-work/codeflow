import { describe, expect, it } from 'vitest';
import { parseAiSettings } from './settings';

describe('AI settings', () => {
  it('stays off and on the editor until the user changes that', () => {
    expect(parseAiSettings({})).toMatchObject({
      enabled: false,
      provider: 'editor',
      modelFamily: '',
      model: '',
      baseUrl: '',
      snippetChars: 240,
    });
    expect(parseAiSettings({ enabled: 'yes', provider: 'ollama' }).provider).toBe('editor');
    expect(parseAiSettings({ enabled: true, provider: 'anthropic' })).toMatchObject({
      enabled: true,
      provider: 'anthropic',
    });
  });

  it('keeps an http base URL and drops anything else', () => {
    expect(parseAiSettings({ baseUrl: ' http://127.0.0.1:11434/v1 ' }).baseUrl).toBe(
      'http://127.0.0.1:11434/v1',
    );
    expect(parseAiSettings({ baseUrl: 'file:///tmp/model' }).baseUrl).toBe('');
    expect(parseAiSettings({ modelFamily: ' gpt-4o ', model: ' haiku ' })).toMatchObject({
      modelFamily: 'gpt-4o',
      model: 'haiku',
    });
  });

  it('clamps snippet length', () => {
    expect(parseAiSettings({ snippetChars: -4 }).snippetChars).toBe(0);
    expect(parseAiSettings({ snippetChars: 9000.9 }).snippetChars).toBe(2000);
    expect(parseAiSettings({ snippetChars: Number.NaN }).snippetChars).toBe(240);
  });
});
