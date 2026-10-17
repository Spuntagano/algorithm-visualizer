/**
 * Makes the images the published page links to, from the built page itself: public/og-image.png (1200×630, the
 * preview a shared link shows: the Fibonacci example with its call tree) and public/apple-touch-icon.png (180×180, the
 * logo).
 * Run after `npm run build`, whenever the look changes: node tools/og-images.mjs
 * The Pages workflow publishes public/ next to the page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page = path.join(ROOT, 'dist', 'algorithm-visualizer.html');
const out = path.join(ROOT, 'public');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1500, height: 788 }, deviceScaleFactor: 0.8 });   // 1200×630, with room for the whole tree
await p.goto(pathToFileURL(page).href);
await p.selectOption('#example', 'Fibonacci with memo');
await p.waitForSelector('#callTree');
for (let i = 0; i < 25; i++) await p.click('#bNext');
await p.mouse.move(0, 0);
await p.waitForTimeout(300);
await p.screenshot({ path: path.join(out, 'og-image.png') });

const icon = await browser.newPage({ viewport: { width: 180, height: 180 } });
const svg = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)"/)[1];
await icon.setContent(`<body style="margin:0"><img src="data:image/svg+xml,${svg}" width="180" height="180" style="display:block">`);
await icon.screenshot({ path: path.join(out, 'apple-touch-icon.png'), omitBackground: true });
await browser.close();
console.log('wrote public/og-image.png and public/apple-touch-icon.png');
