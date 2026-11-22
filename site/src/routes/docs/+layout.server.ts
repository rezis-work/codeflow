import { PUBLIC_SITE_URL } from '$app/env/public';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ url }) => {
  const origin = PUBLIC_SITE_URL ?? url.origin;
  return { origin };
};
