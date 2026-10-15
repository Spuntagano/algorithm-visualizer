/**
 * printf's formatting, as glibc does it: %d %i %u %o %x %X %c %s %p %f %F %e %E %g %G %%, with flags (- + space # 0),
 * width and precision (or *), and the length modifiers hh h l ll z j t L.
 * format(fmt, args, h): args are { t, v, text } (text: how the argument was written, for error messages);
 * h.str(pointer) reads a C string, h.addr(pointer) gives its address, h.fail(message) stops the program.
 */
import { typeName } from './types.js';

const SPEC = /%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|z|j|t|L)?([diuoxXcspfFeEgGaA%])/y;

const pad = (s, width, left, zero) => {
  if (s.length >= width) return s;
  if (left) return s + ' '.repeat(width - s.length);
  if (zero) { const m = /^([+\- ]|0[xX])?/.exec(s)[0]; return m + '0'.repeat(width - s.length) + s.slice(m.length); }
  return ' '.repeat(width - s.length) + s;
};

/** A double in %f style with `prec` decimals (exact for the huge ones too). */
export function fixed(v, prec) {
  if (Math.abs(v) < 1e21) return v.toFixed(prec);
  return BigInt(v).toString() + (prec ? '.' + '0'.repeat(prec) : '');
}
export function expo(v, prec, upper) {
  const s = v.toExponential(Math.min(prec, 100)).replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}
/** %g: the shorter of %f and %e for `prec` significant digits, without trailing zeros (unless #). */
export function general(v, prec, alt, upper) {
  const p = prec === 0 ? 1 : prec;
  if (v === 0) return alt ? (0).toFixed(p - 1) : '0';
  const x = +v.toExponential(p - 1).split('e')[1];
  const s = p > x && x >= -4 ? fixed(v, p - 1 - x) : expo(v, p - 1, upper);
  if (alt) return s.includes('.') || /[eE]/.test(s) ? s : s + '.';   // # keeps the point: 123.
  const strip = t => (t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t);   // only zeros after the point
  const [mant, ex = ''] = s.split(/(?=[eE])/);
  return strip(mant) + ex;
}

const special = (v, upper) => {
  const s = Number.isNaN(v) ? 'nan' : 'inf';
  return upper ? s.toUpperCase() : s;
};

export function format(fmt, args, h) {
  let out = '', ai = 0, i = 0;
  const take = (what) => {
    if (ai >= args.length) h.fail(`the format "${clipFmt(fmt)}" has more % conversions than there are values (the ${what} has none)`);
    return args[ai++];
  };
  while (i < fmt.length) {
    const pc = fmt.indexOf('%', i);
    if (pc < 0) { out += fmt.slice(i); break; }
    out += fmt.slice(i, pc);
    SPEC.lastIndex = pc;
    const m = SPEC.exec(fmt);
    if (!m) h.fail(`printf: "${fmt.slice(pc, pc + 4)}" is not a conversion printf knows (to print a % write %%)`);
    i = SPEC.lastIndex;
    const [, flags, w, pr, len, conv] = m;
    if (conv === '%') { out += '%'; continue; }
    let width = 0, left = flags.includes('-');
    if (w === '*') { width = Number(take('*').v); if (width < 0) { left = true; width = -width; } } else if (w) width = +w;
    let prec = null;
    if (pr === '*') { prec = Number(take('.*').v); if (prec < 0) prec = null; } else if (pr != null) prec = +(pr || 0);
    const a = take('%' + conv), at = a.t;
    const name = a.text ? a.text + ' is ' : 'it is ';
    const plus = flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
    const zero = flags.includes('0') && !left, alt = flags.includes('#');
    if ('diuoxX'.includes(conv)) {
      if (at.k !== 'int') h.fail(`%${conv} prints an integer, but ${name}${article(at)}` + (at.k === 'flt' ? ` (use %f, or (int)${a.text || 'x'})` : at.k === 'ptr' ? ' (use %p for an address' + (isStr(at) ? ', %s for a string' : '') + ')' : ''));
      const bits = len === 'hh' ? 8 : len === 'h' ? 16 : len === 'l' || len === 'll' || len === 'z' || len === 'j' || len === 't' ? 64 : 32;
      let n = BigInt(a.v);
      const signed = conv === 'd' || conv === 'i';
      n = signed ? BigInt.asIntN(bits, n) : BigInt.asUintN(bits, n);
      const neg = n < 0n;
      let digits = (neg ? -n : n).toString(conv === 'o' ? 8 : conv === 'x' || conv === 'X' ? 16 : 10);
      if (conv === 'X') digits = digits.toUpperCase();
      if (prec != null) digits = prec === 0 && n === 0n ? '' : digits.padStart(prec, '0');
      if (alt && conv === 'o' && !digits.startsWith('0')) digits = '0' + digits;
      const pre = neg ? '-' : signed ? plus : alt && n !== 0n && (conv === 'x' || conv === 'X') ? '0' + conv : '';
      out += pad(pre + digits, width, left, zero && prec == null);
    } else if ('fFeEgGaA'.includes(conv)) {
      if (at.k !== 'flt') h.fail(`%${conv} prints a double, but ${name}${article(at)}` + (at.k === 'int' ? ` (use %d, or (double)${a.text || 'x'})` : ''));
      const v = a.v, upper = conv === conv.toUpperCase(), p = prec == null ? 6 : prec;
      let s;
      if (!Number.isFinite(v)) s = special(v, upper);
      else if (conv === 'f' || conv === 'F') s = fixed(Math.abs(v), p);
      else if (conv === 'e' || conv === 'E') s = expo(Math.abs(v), p, upper);
      else if (conv === 'g' || conv === 'G') s = general(Math.abs(v), p, alt, upper);
      else s = hexFloat(Math.abs(v), upper);
      const neg = v < 0 || Object.is(v, -0);
      out += pad((neg ? '-' : plus) + s, width, left, zero && Number.isFinite(v));
    } else if (conv === 'c') {
      if (at.k !== 'int') h.fail(`%c prints a character, but ${name}${article(at)}` + (isStr(at) ? ' (use %s for a string)' : ''));
      out += pad(String.fromCharCode(Number(BigInt.asUintN(8, BigInt(a.v)))), width, left, false);
    } else if (conv === 's') {
      if (at.k !== 'ptr' && at.k !== 'arr') h.fail(`%s prints a string, but ${name}${article(at)}` + (at.k === 'int' ? ' (use %d for a number, %c for one character)' : ''));
      let s = a.v === null ? '(null)' : h.str(a.v, prec == null ? Infinity : prec);
      if (prec != null) s = s.slice(0, prec);
      out += pad(s, width, left, false);
    } else if (conv === 'p') {
      if (at.k !== 'ptr') h.fail(`%p prints an address, but ${name}${article(at)}`);
      out += pad(a.v === null ? '(nil)' : '0x' + h.addr(a.v).toString(16), width, left, false);
    }
  }
  return out;
}

const isStr = t => t.k === 'ptr' && t.to.k === 'int' && t.to.size === 1;
const article = t => { const n = typeName(t); return (/^[aeiou]/.test(n) ? 'an ' : 'a ') + n; };
const clipFmt = s => (s.length > 30 ? s.slice(0, 29) + '…' : s).replace(/\n/g, '\\n');
function hexFloat(v, upper) {
  if (v === 0) return upper ? '0X0P+0' : '0x0p+0';
  let e = Math.floor(Math.log2(v)), m = v / 2 ** e;
  if (m >= 2) { m /= 2; e++; }
  let frac = (m - 1).toString(16).slice(2).replace(/0+$/, '');
  const s = '0x1' + (frac ? '.' + frac : '') + 'p' + (e < 0 ? '-' : '+') + Math.abs(e);
  return upper ? s.toUpperCase() : s;
}
