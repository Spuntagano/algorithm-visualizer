/**
 * The graph views are computed as plain lists of SVG "primitives" ({ tag, p: props, text | kids }),
 * and drawn by <Prims> in components/Graph.jsx. Keeping drawing data separate from React means layout
 * and change-highlighting can be tested without a DOM, and the components stay trivial.
 *
 * Props use React names (className, textAnchor, markerEnd). `markerEnd` is 'arrow' or 'arrow-chg';
 * <Prims> turns it into the url(#…) of the marker defined by the enclosing <svg>.
 */

/** @returns {{ tag: string, p: Record<string, any>, text?: string, kids?: any[] }} */
export const P = (tag, p, text) => ({ tag, p, text });

/** A <text> with several differently-styled runs. */
export const runs = (p, kids) => ({ tag: 'text', p, kids });
