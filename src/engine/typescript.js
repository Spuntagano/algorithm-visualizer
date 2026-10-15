/**
 * TypeScript support: the types are stripped (Sucrase) and the JavaScript tracer runs what is left. Sucrase keeps every
 * line where it was (an interface becomes a blank line, an enum or a constructor's parameter properties stay on their
 * own lines), so steps, breakpoints and the current line point at the TypeScript the viewer wrote. It does not check
 * types: like running `tsc` with type errors allowed, only syntax errors stop a run.
 */
import { transform } from 'sucrase';

/** JavaScript for `code`. Throws a SyntaxError-like Error ("Unexpected token (3:7)") when it does not parse. */
export function stripTypes(code) {
  return transform(code, { transforms: ['typescript'], disableESTransforms: true }).code;
}
