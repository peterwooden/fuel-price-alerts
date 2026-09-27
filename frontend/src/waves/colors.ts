// Chart colours. Ramps validated with the dataviz palette checks (monotone lightness,
// visible steps, light end >= 2:1 on the surface).

export const ink = {
    primary: '#0b0b0b',
    secondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    surface: '#fcfcfb',
};

/** Order stations moved in: first (dark) to last (light). One hue. */
const ARRIVAL = ['#0d366b', '#1c5cab', '#3987e5', '#86b6ef'];
/** Price change: cuts (blue) through unchanged (gray) to rises (red). */
const CUTS = ['#c3c2b7', '#86b6ef', '#3987e5', '#184f95'];
const RISES = ['#c3c2b7', '#e98f8b', '#e34948', '#a52a26'];

export const RISE = '#e34948';
export const CUT = '#3987e5';
export const UNCHANGED = '#c3c2b7';

const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Piecewise-linear interpolation along a ramp, f in [0, 1]. */
function along(ramp: string[], f: number): string {
    const x = Math.min(1, Math.max(0, f)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(x));
    const a = parse(ramp[i]);
    const b = parse(ramp[i + 1]);
    return toHex(a.map((v, k) => v + (b[k] - v) * (x - i)));
}

/** f = 0 for the first station to move, 1 for the last. */
export const arrivalColor = (f: number) => along(ARRIVAL, f);
export const arrivalGradient = `linear-gradient(to right, ${ARRIVAL.join(', ')})`;

/** Colour for a price change of `cents`, saturating at +/- `max`. */
export function changeColor(cents: number, max: number): string {
    if (!(Math.abs(cents) >= 0.05)) return UNCHANGED; // also covers an unknown (NaN) change
    return along(cents > 0 ? RISES : CUTS, Math.abs(cents) / max);
}
export const changeGradient = `linear-gradient(to right, ${[...CUTS].reverse().join(', ')}, ${RISES.slice(1).join(', ')})`;
