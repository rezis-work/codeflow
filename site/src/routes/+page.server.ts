import { PUBLIC_SITE_URL } from '$app/env/public';
import type { PageServerLoad } from './$types';
import { description, licenseUrl, marketplaceUrl, repoUrl, title } from '#lib/content.ts';

export const load: PageServerLoad = ({ url }) => {
  const origin = PUBLIC_SITE_URL ?? url.origin;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Rezis CodeFlow',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows, macOS, Linux',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    license: licenseUrl,
    codeRepository: repoUrl,
    installUrl: marketplaceUrl,
    description,
  };
  return { origin, title, description, jsonLd: JSON.stringify(jsonLd).replace(/</g, '\\u003c') };
};
