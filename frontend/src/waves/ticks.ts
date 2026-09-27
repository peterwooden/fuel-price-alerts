// Axis ticks: round numbers for prices, Sydney clock or calendar times for time.

import { DAY, formatShortDate, formatTime, HOUR, startOfSydneyDay, sydneyDays } from './time';

/** About `count` round values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
    const span = max - min || 1;
    const raw = span / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
    const ticks: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return ticks;
}

const STEPS = [0.25, 0.5, 1, 2, 3, 6, 12, 24, 48, 7 * 24, 14 * 24, 28 * 24].map((h) => h * HOUR);

export interface TimeTick {
    t: number;
    label: string;
}

/** At most `max` ticks on Sydney clock boundaries (hours) or midnights (days). */
export function timeTicks(start: number, end: number, max = 5): TimeTick[] {
    const step = STEPS.find((s) => (end - start) / s <= max) ?? STEPS[STEPS.length - 1];
    if (step >= DAY) {
        const every = Math.round(step / DAY);
        return sydneyDays(start, end)
            .filter((d) => d >= start)
            .filter((d, i) => i % every === 0)
            .map((t) => ({ t, label: formatShortDate(t) }));
    }
    const ticks: TimeTick[] = [];
    // Count steps from Sydney midnight so 6-hourly ticks land on 6am, noon, 6pm.
    const midnight = startOfSydneyDay(start);
    for (let t = midnight + Math.ceil((start - midnight) / step) * step; t <= end; t += step) {
        // Midnights carry the date, so ticks across several days stay unambiguous.
        ticks.push({ t, label: startOfSydneyDay(t) === t ? formatShortDate(t) : formatTime(t).replace(':00', '') });
    }
    return ticks;
}
