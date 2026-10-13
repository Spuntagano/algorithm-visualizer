/**
 * Stable colours: the same variable name or object id always gets the same hue, in light and dark
 * (lightness comes from the --chipL CSS variable, set per theme in css/tokens.css).
 */

/** Hue 0-359 for a number (object id) or a string (variable name). */
export const hueOf = s => (Math.abs(typeof s === 'number' ? s * 67 : [...String(s)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 360);

/** SVG fill for text/shapes coloured by id or name. */
export const idFill = id => ({ fill: 'hsl(' + hueOf(id) + ' 65% var(--chipL))' });
/** Same hue, faint: for the pill behind such text. */
export const idBgFill = id => ({ fill: 'hsl(' + hueOf(id) + ' 65% var(--chipL) / .16)' });
