# Rezis CodeFlow site

Marketing page for [Rezis CodeFlow](https://github.com/rezis-work/codeflow). SvelteKit (Svelte 5, TypeScript) with server rendering. The Vercel adapter is configured in `vite.config.ts`.

This folder is not an npm workspace. Install and build it here. The extension package, tests, and release workflow do not use it.

## Run locally

Requires Node.js 22 or newer.

```sh
cd site
npm ci
npm run dev
```

The dev server prints a local URL. `npm run check` runs `svelte-check`. `npm run build` then `npm run preview` serves the production build.

## Deploy on Vercel

1. Import the GitHub repository.
2. Set **Root Directory** to `site`.
3. Leave the framework as **SvelteKit**. The adapter is `@sveltejs/adapter-vercel`.
4. Set the environment variable `PUBLIC_SITE_URL` to the production origin, with no trailing slash, for example `https://your-project.vercel.app`. The canonical URL and `og:image` use that value. When it is unset, the page uses the request origin, so a crawler that fetches the deployment still receives an absolute image URL.

Do not set the root of the repository as the Vercel project root. The extension is a separate npm workspace.

`og.png` (1200×630) and the favicon are in `static/`. The favicon is the extension icon. `static/og.svg` is the source for the PNG:

```sh
rsvg-convert -w 1200 -h 630 static/og.svg -o static/og.png
```

LinkedIn reads `og:image`. After the first deploy, set `PUBLIC_SITE_URL` to the URL you will share and redeploy so the preview points at that origin.
