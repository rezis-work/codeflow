import { error } from '@sveltejs/kit';
import { findDoc } from '#lib/docs.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  const page = findDoc('overview');
  if (!page) {
    error(500, 'Missing the docs overview.');
  }
  return { page };
};
