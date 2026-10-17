/**
 * Makes docs/demo.gif, the README's animation: the Binary heap example stepped through from the first push to the last
 * pop, one frame per step, in the Heap view. Run after `npm run build`, whenever the look changes: node tools/demo-gif.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page = path.join(ROOT, 'dist', 'algorithm-visualizer.html');
const FRAME_MS = 140, FIRST_MS = 1500, LAST_MS = 2500;
const MAX_STEPS = 400;

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 760 } });
await p.goto(pathToFileURL(page).href);
await p.selectOption('#example', 'Binary heap');
await p.waitForSelector('#stateBody');
await p.mouse.move(0, 0);

const frames = [];
const grab = async () => frames.push(PNG.sync.read(await p.screenshot()));
await grab();
for (let i = 0; i < MAX_STEPS && !(await p.isDisabled('#bNext')); i++) {
  await p.click('#bNext');
  await p.mouse.move(0, 0);
  await p.waitForTimeout(30);
  await grab();
}
await browser.close();

// One palette for the whole animation, so a pixel that does not change keeps its index and can be left transparent:
// each frame after the first then only stores what changed since the one before, which keeps the file small.
const { width, height } = frames[0];
const sample = Buffer.concat(frames.filter((_, i) => i % 10 === 0).map((f) => f.data));
const palette = quantize(sample, 255);
const CLEAR = palette.length;
palette.push([0, 0, 0]);
const gif = GIFEncoder();
let prev = null;
frames.forEach(({ data }, i) => {
  const index = applyPalette(data, palette.slice(0, CLEAR));
  const out = index.slice();
  if (prev) for (let k = 0; k < out.length; k++) if (index[k] === prev[k]) out[k] = CLEAR;
  const delay = i === 0 ? FIRST_MS : i === frames.length - 1 ? LAST_MS : FRAME_MS;
  gif.writeFrame(out, width, height, {
    palette: i === 0 ? palette : undefined, delay, transparent: !!prev, transparentIndex: CLEAR, dispose: 1,
  });
  prev = index;
});
gif.finish();
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'demo.gif'), gif.bytes());
console.log(`wrote docs/demo.gif (${frames.length} frames, ${(gif.bytes().length / 1e6).toFixed(1)} MB)`);
