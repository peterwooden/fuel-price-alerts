// Everything on the page is shown in Sydney time, whatever the viewer's time zone.

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
const TZ = 'Australia/Sydney';

const partsFormat = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
});

/** Sydney's offset from UTC at time t, in ms (+10 h or +11 h). */
function offsetAt(t: number): number {
    const p: Record<string, number> = {};
    for (const { type, value } of partsFormat.formatToParts(t)) p[type] = Number(value);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return wall - Math.floor(t / 60000) * 60000;
}

/** Midnight in Sydney at the start of the day containing t. */
export function startOfSydneyDay(t: number): number {
    const wall = t + offsetAt(t);
    const midnightWall = wall - (((wall % DAY) + DAY) % DAY);
    // The offset at midnight can differ from the offset at t on daylight-saving days.
    return midnightWall - offsetAt(midnightWall - offsetAt(t));
}

/** Midnight in Sydney at the start of every day that overlaps [from, to]. */
export function sydneyDays(from: number, to: number): number[] {
    const days: number[] = [];
    // Step by 25 h and snap back, so days of 23 or 25 hours are neither skipped nor repeated.
    for (let d = startOfSydneyDay(from); d <= to; d = startOfSydneyDay(d + 25 * HOUR)) days.push(d);
    return days;
}

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, ...options });
const dayFormat = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const timeFormat = fmt({ hour: 'numeric', minute: '2-digit', hour12: true });
const shortDateFormat = fmt({ day: 'numeric', month: 'short' });

const lowerAmPm = (s: string) => s.replace(/\s?([AaPp])\.?[Mm]\.?/, (_, x: string) => `${x.toLowerCase()}m`);

/** "Mon 3 Aug" */
export const formatDay = (t: number) => dayFormat.format(t).replace(',', '');
/** "6:05am" */
export const formatTime = (t: number) => lowerAmPm(timeFormat.format(t));
/** "Mon 3 Aug, 6:05am" */
export const formatDayTime = (t: number) => `${formatDay(t)}, ${formatTime(t)}`;
/** "3 Aug" */
export const formatShortDate = (t: number) => shortDateFormat.format(t);

/** A time within a window: just the clock time if the window is about a day or less. */
export const formatWithin = (t: number, span: number) =>
    span <= 26 * HOUR ? formatTime(t) : `${formatShortDate(t)} ${formatTime(t)}`;

/** A duration in hours, readably: "25 min", "2.5 h", "45 h", "3.5 d". Hours up to 3 days, so gaps compare easily. */
export function formatHours(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    if (hours < 10) return `${Math.round(hours * 10) / 10} h`;
    if (hours < 72) return `${Math.round(hours)} h`;
    return `${Math.round(hours / 2.4) / 10} d`;
}
