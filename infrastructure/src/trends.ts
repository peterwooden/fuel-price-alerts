// Pure alerting logic. This is a port of the original Postgres implementation
// (function get_price_trends_at_time + the alert query in fetch-prices.ts) and was
// verified against it row-for-row before Aurora was retired; see test/fixtures.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const ALERT_THRESHOLD = 0.05;

/** [epoch millis, price as the exact decimal string the API returned] */
export type Point = [number, string];

/** Price points per `${stationCode}|${fuelType}`, sorted ascending by time, unique times. */
export type SeriesMap = Record<string, Point[]>;

export interface Station {
    brand_id: string;
    station_id: string;
    brand: string;
    code: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    state: string;
}

export type StationMap = Record<string, Station>;

export interface Subscription {
    email: string;
    fuelType: string;
    stations: string[];
}

export interface Trend {
    code: string;
    fuelType: string;
    price: number;
    timeWeightedAverage: number;
    change: number;
    prices: { time: string; price: number }[];
}

export interface AlertEmail {
    email: string;
    alerts: {
        stationName: string;
        fuelType: string;
        price: number;
        timeWeightedPrice: number;
        changePercent: number;
        recentPrices: { time: string; price: number }[];
    }[];
}

export const seriesKey = (code: string, fuelType: string) => `${code}|${fuelType}`;

export const splitSeriesKey = (key: string) => {
    const i = key.indexOf('|');
    return { code: key.slice(0, i), fuelType: key.slice(i + 1) };
};

/**
 * The points the original SQL called `recent_prices`: every point in [t - 1 week, t)
 * plus the last point before the window, which carries the price into it.
 */
export function recentPoints(points: Point[], t: number): Point[] {
    const windowStart = t - WEEK_MS;
    let prior: Point | undefined;
    const recent: Point[] = [];
    for (const p of points) {
        if (p[0] < windowStart) prior = p;
        else if (p[0] < t) recent.push(p);
        else break;
    }
    return prior ? [prior, ...recent] : recent;
}

/** Current price, time-weighted average over the past week and relative change at time t. */
export function trendAt(points: Point[], t: number): Omit<Trend, 'code' | 'fuelType'> | undefined {
    const recent = recentPoints(points, t);
    if (recent.length === 0) return undefined;

    const windowStart = t - WEEK_MS;
    let timeWeightedAverage = 0;
    for (let i = 0; i < recent.length; i++) {
        const [ts, price] = recent[i];
        const until = i + 1 < recent.length ? recent[i + 1][0] : t;
        timeWeightedAverage += ((until - Math.max(ts, windowStart)) / WEEK_MS) * Number(price);
    }
    const price = Number(recent[recent.length - 1][1]);

    return {
        price,
        timeWeightedAverage,
        change: (price - timeWeightedAverage) / Math.max(timeWeightedAverage, 1),
        prices: recent.map(([ts, p]) => ({ time: new Date(ts).toISOString(), price: Number(p) })),
    };
}

/** Trends for every series whose station is known (the SQL inner-joined on stations). */
export function computeTrends(series: SeriesMap, stations: StationMap, t: number): Trend[] {
    const trends: Trend[] = [];
    for (const [key, points] of Object.entries(series)) {
        const { code, fuelType } = splitSeriesKey(key);
        if (!stations[code]) continue;
        const trend = trendAt(points, t);
        if (trend) trends.push({ code, fuelType, ...trend });
    }
    return trends;
}

/**
 * Decide who gets emailed and which series are newly alerting.
 *
 * A user is emailed when at least one of their series rose more than 5% above its
 * weekly average and that series hasn't alerted in the past week. The email lists all
 * of the user's series, most-risen first. Every newly alerting series is recorded,
 * whether or not anyone subscribes to it (same as the original previous_alerts table).
 */
export function selectAlerts({
    trends,
    subscriptions,
    stations,
    lastAlert,
    t,
}: {
    trends: Trend[];
    subscriptions: Subscription[];
    stations: StationMap;
    lastAlert: Record<string, number>;
    t: number;
}): { emails: AlertEmail[]; newAlerts: string[] } {
    const byKey = new Map(trends.map((trend) => [seriesKey(trend.code, trend.fuelType), trend]));
    const isFresh = (trend: Trend) => {
        if (trend.change <= ALERT_THRESHOLD) return false;
        const last = lastAlert[seriesKey(trend.code, trend.fuelType)];
        return last === undefined || !(t - WEEK_MS < last && last <= t);
    };

    const emails: AlertEmail[] = [];
    for (const subscription of subscriptions) {
        const rows = subscription.stations
            .map((code) => byKey.get(seriesKey(code, subscription.fuelType)))
            .filter((trend): trend is Trend => trend !== undefined);
        if (!rows.some(isFresh)) continue;

        emails.push({
            email: subscription.email,
            alerts: rows
                .sort((a, b) => b.change - a.change)
                .map((trend) => ({
                    stationName: stations[trend.code].name,
                    fuelType: trend.fuelType,
                    price: trend.price,
                    timeWeightedPrice: trend.timeWeightedAverage,
                    changePercent: trend.change * 100,
                    recentPrices: trend.prices,
                })),
        });
    }

    const newAlerts = trends.filter(isFresh).map((trend) => seriesKey(trend.code, trend.fuelType));
    return { emails, newAlerts };
}

/** Insert points, keeping the series sorted and unique by time. Returns the points actually added. */
export function mergePoints(series: SeriesMap, key: string, incoming: Point[]): Point[] {
    const existing = series[key] ?? [];
    const seen = new Set(existing.map((p) => p[0]));
    const added: Point[] = [];
    for (const point of incoming) {
        if (seen.has(point[0])) continue;
        seen.add(point[0]);
        added.push(point);
    }
    if (added.length) series[key] = [...existing, ...added].sort((a, b) => a[0] - b[0]);
    return added;
}

/**
 * Drop points no future run (at time >= t) can need: everything before the last point
 * preceding the window. That point is kept because it carries the price into the window.
 */
export function prunePoints(points: Point[], t: number): Point[] {
    const windowStart = t - WEEK_MS;
    let firstKept = 0;
    for (let i = 0; i < points.length; i++) {
        if (points[i][0] < windowStart) firstKept = i;
        else break;
    }
    return points.slice(firstKept);
}

export function pruneState(series: SeriesMap, lastAlert: Record<string, number>, t: number) {
    for (const key of Object.keys(series)) series[key] = prunePoints(series[key], t);
    for (const [key, at] of Object.entries(lastAlert)) if (at <= t - WEEK_MS) delete lastAlert[key];
}
