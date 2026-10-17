/**
 * Share links: the code and its language live in the link itself, after the # (so no server stores them, and the
 * published site, a static page, can open them). The code is compressed (deflate) and written in base64url:
 *
 *   https://algorithmvisualizer.io/#lang=python&z=<compressed code>
 *   https://algorithmvisualizer.io/#lang=python&step=25&z=…    opened at step 25 (counting from 1, as the timeline does)
 *   https://algorithmvisualizer.io/#embed&lang=python&z=…      the same, laid out to sit in another page's <iframe>
 *
 * A browser without CompressionStream writes and reads `code=` (the plain text in base64url) instead of `z=`.
 */
export const SITE_URL = 'https://algorithmvisualizer.io/';

const toB64url = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function through(stream, bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const canZip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** The part after the #: `lang=…&z=…`, with `embed&` first for an embed and `step=N` for a step other than the first. */
export async function encodeShare(code, lang, { embed = false, step = null } = {}) {
  const bytes = new TextEncoder().encode(code);
  const data = canZip() ? 'z=' + toB64url(await through(new CompressionStream('deflate-raw'), bytes)) : 'code=' + toB64url(bytes);
  return (embed ? 'embed&' : '') + 'lang=' + encodeURIComponent(lang) + (step > 1 ? '&step=' + Math.floor(step) : '') + '&' + data;
}

/** Whether a location hash asks for the embed layout (readable at once, before the code is unpacked). */
export const isEmbedHash = hash => new URLSearchParams(String(hash || '').replace(/^#/, '')).has('embed');

/**
 * The code a location hash carries: { code, lang, embed, step } (step: the one to open at, from 1, or null for the
 * first), or null when it carries none (or it cannot be read: a link cut short when it was copied).
 */
export async function decodeShare(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const lang = q.get('lang'), z = q.get('z'), plain = q.get('code');
  if (!lang || (z == null && plain == null)) return null;
  try {
    const bytes = z != null ? await through(new DecompressionStream('deflate-raw'), fromB64url(z)) : fromB64url(plain);
    const step = /^\d+$/.test(q.get('step') || '') && +q.get('step') > 1 ? +q.get('step') : null;
    return { code: new TextDecoder('utf-8', { fatal: true }).decode(bytes), lang, embed: q.has('embed'), step };
  } catch {
    return null;
  }
}

/** Where links point: this page when it is served over http(s), else (a file opened from disk) the published site. */
export const pageUrl = () => (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin + location.pathname : SITE_URL);

/** The full link, and the <iframe> markup that embeds the same code (both opening at `step`, from 1, when given). */
export async function shareLinks(code, lang, base = pageUrl(), { step = null } = {}) {
  const [link, embed] = await Promise.all([encodeShare(code, lang, { step }), encodeShare(code, lang, { embed: true, step })]);
  const src = base + '#' + embed;
  return {
    link: base + '#' + link,
    embedSrc: src,
    iframe: `<iframe src="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" title="Algorithm visualizer" width="100%" height="600" style="border: 1px solid #d0d7de; border-radius: 8px" loading="lazy"></iframe>`,
  };
}
