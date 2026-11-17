import { defineEnvVars } from '@sveltejs/kit/env';

/** Production origin for canonical and og:image. Unset means use the request origin. */
export const variables = defineEnvVars({
  PUBLIC_SITE_URL: {
    public: true,
    description: 'Production origin with no trailing slash. When unset, the page uses the request origin.',
    schema: (value) => {
      const trimmed = value?.trim().replace(/\/$/, '') ?? '';
      if (!trimmed) return undefined;
      if (!/^https?:\/\//.test(trimmed)) {
        throw new Error('PUBLIC_SITE_URL must start with http:// or https://');
      }
      return trimmed;
    },
  },
});
