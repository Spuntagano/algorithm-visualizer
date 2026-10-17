/** Share links (src/share.js): the code and language packed into the part of the link after the #. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SITE_URL, decodeShare, encodeShare, isEmbedHash, pageUrl, shareLinks } from '../src/share.js';
import { EXAMPLES, PY_EXAMPLES } from '../src/examples.js';

test('a link opens the same code in the same language, accents and emoji included', async () => {
  for (const [code, lang] of [[PY_EXAMPLES['Binary heap'], 'python'], ['const s = "héllo 👋";\n\tconsole.log(s);', 'javascript'], ['x', 'lua']]) {
    const hash = await encodeShare(code, lang);
    assert.match(hash, /^lang=\w+&z=[\w-]+$/, 'only characters that need no escaping');
    assert.deepEqual(await decodeShare('#' + hash), { code, lang, embed: false, step: null });
  }
});

test('compressed: a long example makes a much shorter link', async () => {
  const code = EXAMPLES['Data structures'];
  const hash = await encodeShare(code, 'javascript');
  assert.ok(hash.length < code.length * 0.8, hash.length + ' characters for ' + code.length);
});

test('an embed link says so, and is told apart before the code is unpacked', async () => {
  const hash = await encodeShare('print(1)', 'python', { embed: true });
  assert.match(hash, /^embed&lang=python&z=/);
  assert.ok(isEmbedHash('#' + hash));
  assert.ok(!isEmbedHash('#lang=python&z=abc'));
  assert.ok(!isEmbedHash(''));
  assert.deepEqual(await decodeShare('#' + hash), { code: 'print(1)', lang: 'python', embed: true, step: null });
});

test('a link can open at a step (counted from 1, like the timeline); the first step needs no mention', async () => {
  const hash = await encodeShare('x = 1', 'python', { step: 25 });
  assert.match(hash, /^lang=python&step=25&z=/);
  assert.equal((await decodeShare('#' + hash)).step, 25);
  assert.match(await encodeShare('x = 1', 'python', { embed: true, step: 3 }), /^embed&lang=python&step=3&z=/);
  assert.doesNotMatch(await encodeShare('x = 1', 'python', { step: 1 }), /step/);
  const z = hash.split('&z=')[1];
  for (const bad of ['0', '1', '-4', 'abc', '2.5']) assert.equal((await decodeShare('#lang=python&step=' + bad + '&z=' + z)).step, null, bad);
  const { link, iframe } = await shareLinks('x = 1', 'python', 'https://example.com/', { step: 7 });
  assert.match(link, /#lang=python&step=7&z=/);
  assert.match(iframe, /#embed&amp;lang=python&amp;step=7&amp;z=/);
});

test('the plain form (from a browser that cannot compress) opens too', async () => {
  const b64 = Buffer.from('print("é")').toString('base64url');
  assert.deepEqual(await decodeShare('#lang=python&code=' + b64), { code: 'print("é")', lang: 'python', embed: false, step: null });
});

test('no code, or a link cut short: nothing to open', async () => {
  assert.equal(await decodeShare(''), null);
  assert.equal(await decodeShare('#top'), null);
  assert.equal(await decodeShare('#lang=python'), null);
  const hash = await encodeShare(EXAMPLES['Binary heap'], 'javascript');
  assert.equal(await decodeShare('#' + hash.slice(0, -20)), null);
});

test('the link and the iframe point at the page, the iframe safely quoted', async () => {
  const { link, embedSrc, iframe } = await shareLinks('a & b', 'javascript', 'https://example.com/av/');
  assert.match(link, /^https:\/\/example\.com\/av\/#lang=javascript&z=/);
  assert.match(embedSrc, /^https:\/\/example\.com\/av\/#embed&lang=javascript&z=/);
  assert.ok(iframe.startsWith('<iframe src="' + embedSrc.replace(/&/g, '&amp;') + '" title="Algorithm visualizer"'));
  assert.match(iframe, /loading="lazy"><\/iframe>$/);
  assert.equal(pageUrl(), SITE_URL, 'with no page (Node), links point at the published site');
});
