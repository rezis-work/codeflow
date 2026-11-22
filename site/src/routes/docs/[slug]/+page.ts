import { error, redirect } from '@sveltejs/kit';
import { findDoc } from '#lib/docs.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  if (params.slug === 'overview') {
    redirect(308, '/docs');
  }
  const page = findDoc(params.slug);
  if (!page) {
    error(404, 'That docs page does not exist.');
  }
  return { page };
};
