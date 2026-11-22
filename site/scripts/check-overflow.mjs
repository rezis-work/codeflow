import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.OVERFLOW_PORT ?? 4179);
const base = `http://127.0.0.1:${port}`;
const widths = [320, 360, 375, 390, 414, 768];
const screenshotDir = process.env.OVERFLOW_SCREENSHOTS;

const require = createRequire(import.meta.url);

function loadChromium() {
  try {
    return require('playwright').chromium;
  } catch {
    console.error('Playwright is not installed. From site/, run: npm install');
    process.exit(1);
  }
}

async function routes() {
  const files = await readdir(path.join(root, 'src/lib/content'));
  const docs = files
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3))
    .sort()
    .map((slug) => (slug === 'overview' ? '/docs' : `/docs/${slug}`));
  return ['/', ...docs];
}

function startPreview() {
  const viteBin = path.join(root, 'node_modules/vite/bin/vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  return { child, log: () => log };
}

async function waitForServer(child) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) {
      throw new Error(`vite preview exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      // Preview is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for vite preview');
}

async function measure(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > viewport + 1 || rect.left < -1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          className: String(el.className).slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        });
      }
    }
    return { viewport, scrollWidth, offenders: offenders.slice(0, 8) };
  });
}

const pages = await routes();
const { child, log } = startPreview();
const chromium = loadChromium();
const failures = [];

try {
  await waitForServer(child);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const route of pages) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      const response = await page.goto(`${base}${route}`, { waitUntil: 'load' });
      if (!response || response.status() >= 400) {
        failures.push(`${route} @ ${width}px failed to load (${response?.status() ?? 'no response'})`);
        continue;
      }
      const result = await measure(page);
      const ok = result.scrollWidth <= result.viewport;
      console.log(
        `${ok ? 'ok' : 'OVERFLOW'} ${route} @ ${width}px scrollWidth=${result.scrollWidth} viewport=${result.viewport}`,
      );
      if (!ok) {
        failures.push(
          `${route} @ ${width}px scrollWidth ${result.scrollWidth} > viewport ${result.viewport} ${JSON.stringify(result.offenders)}`,
        );
      }
      if (screenshotDir && width === 375 && (route === '/' || route === '/docs' || route === '/docs/cli')) {
        const name = route === '/' ? 'landing' : route === '/docs' ? 'docs' : 'cli';
        await page.screenshot({
          path: path.join(screenshotDir, `mobile-${name}-375.png`),
          fullPage: true,
        });
      }
    }
  }

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const landingMenu = await measure(page);
  console.log(
    `menu / @ 375px scrollWidth=${landingMenu.scrollWidth} viewport=${landingMenu.viewport}`,
  );
  if (landingMenu.scrollWidth > landingMenu.viewport) {
    failures.push(`open header menu overflow ${JSON.stringify(landingMenu.offenders)}`);
  }

  await page.goto(`${base}/docs/cli`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Docs menu' }).click();
  const docsMenu = await measure(page);
  console.log(
    `docs drawer /docs/cli @ 375px scrollWidth=${docsMenu.scrollWidth} viewport=${docsMenu.viewport}`,
  );
  if (docsMenu.scrollWidth > docsMenu.viewport) {
    failures.push(`open docs drawer overflow ${JSON.stringify(docsMenu.offenders)}`);
  }
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'mobile-docs-drawer-375.png'),
      fullPage: false,
    });
  }

  await browser.close();
} catch (error) {
  console.error(log());
  console.error(error);
  child.kill('SIGTERM');
  process.exit(1);
} finally {
  child.kill('SIGTERM');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`No horizontal overflow on ${pages.length} routes at ${widths.join(', ')}px.`);
process.exit(0);
