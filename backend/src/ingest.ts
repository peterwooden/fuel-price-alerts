// Scheduled every 2 hours: pull all NSW prices, append new ones to history, update the
// hot window, work out which series are rising and email subscribers.

import { loadConfig } from './config';
import { sendAlertEmails, sendEmail } from './email';
import { fetchNswPrices, HttpError, NswPrice, NswStation, parseNswTimestamp } from './nsw-api';
import {
    ALERT_COLUMNS,
    alertIdentity,
    keys,
    PRICE_COLUMNS,
    priceIdentity,
    Store,
    utcDay,
    utcMonth,
} from './store';
import {
    AlertEmail,
    computeTrends,
    mergePoints,
    pruneState,
    selectAlerts,
    seriesKey,
    splitSeriesKey,
    Station,
} from './trends';

export interface IngestDeps {
    store: Store;
    fetchPrices: () => Promise<{ stations: NswStation[]; prices: NswPrice[] }>;
    sendAlertEmails: (emails: AlertEmail[]) => Promise<number>;
}

export function toStation(s: NswStation): Station {
    return {
        brand_id: s.brandid,
        station_id: s.stationid,
        brand: s.brand,
        code: String(s.code),
        name: s.name,
        address: s.address,
        latitude: Number(s.location.latitude),
        longitude: Number(s.location.longitude),
        state: s.state,
    };
}

export async function ingest({ store, fetchPrices, sendAlertEmails }: IngestDeps, t: number) {
    const [storedState, storedStations, subscriptions] = await Promise.all([
        store.getState(),
        store.getStations(),
        store.listSubscriptions(),
    ]);
    // Never silently start from an empty window: that would wipe out a week of trend data.
    if (!storedState) throw new Error(`${keys.state} is missing; rebuild it with scripts/build-state.ts`);
    const state = storedState.value;
    const stations = storedStations?.value ?? {};

    const api = await fetchPrices();

    let stationsChanged = false;
    for (const raw of api.stations) {
        const station = toStation(raw);
        if (JSON.stringify(stations[station.code]) !== JSON.stringify(station)) {
            stations[station.code] = station;
            stationsChanged = true;
        }
    }

    // A price is new if the hot window doesn't already hold that exact (series, time).
    // The window always holds each series' latest point, which is what the API returns.
    const newRowsByDay = new Map<string, string[][]>();
    for (const p of api.prices) {
        const code = String(p.stationcode);
        const timestamp = parseNswTimestamp(p.lastupdated);
        const price = String(p.price);
        if (!mergePoints(state.series, seriesKey(code, p.fueltype), [[Date.parse(timestamp), price]]).length) continue;
        const day = utcDay(timestamp);
        if (!newRowsByDay.has(day)) newRowsByDay.set(day, []);
        newRowsByDay.get(day)!.push([code, p.state, p.fueltype, price, timestamp]);
    }

    const trends = computeTrends(state.series, stations, t);
    const { emails, newAlerts } = selectAlerts({
        trends,
        subscriptions,
        stations,
        lastAlert: state.lastAlert,
        t,
    });

    // History first: appends are idempotent, so if anything below fails the next run
    // simply rewrites the same rows. Only then commit the hot window.
    let historyRows = 0;
    for (const [day, rows] of newRowsByDay) {
        historyRows += (await store.appendHistory(keys.priceHistory(day), PRICE_COLUMNS, rows, priceIdentity)).length;
    }
    const alertTime = new Date(t).toISOString();
    if (newAlerts.length) {
        await store.appendHistory(
            keys.alertHistory(utcDay(alertTime)),
            ALERT_COLUMNS,
            newAlerts.map((key) => {
                const { code, fuelType } = splitSeriesKey(key);
                return [code, fuelType, alertTime];
            }),
            alertIdentity,
        );
    }
    if (stationsChanged) await store.putJson(keys.stations, stations);

    for (const key of newAlerts) state.lastAlert[key] = t;
    pruneState(state.series, state.lastAlert, t);
    state.updatedAt = new Date().toISOString();
    // Conditional write: a concurrent run makes this fail instead of losing an update.
    await store.putJson(keys.state, state, { ifMatch: storedState.etag });

    // Emails go out after the alerts are committed, so a retry never double-sends.
    const emailsSent = await sendAlertEmails(emails);

    // Last, refresh the Parquet copies of any month that changed. They're derived from the
    // CSVs, so a failure here loses nothing and is repaired by the next run touching that month.
    const priceMonths = new Set([...newRowsByDay.keys()].map(utcMonth));
    for (const month of priceMonths) await store.rebuildMonthlyParquet('prices', month);
    if (newAlerts.length) await store.rebuildMonthlyParquet('alerts', utcMonth(alertTime));
    // And the public Sydney prices the site's price-waves page reads, derived the same way.
    const sydneyStations = newRowsByDay.size ? await store.rebuildSydneyPrices(stations, t) : 0;

    return {
        at: alertTime,
        stations: api.stations.length,
        prices: api.prices.length,
        newPrices: historyRows,
        seriesInWindow: Object.keys(state.series).length,
        trends: trends.length,
        newAlerts: newAlerts.length,
        emailsSent,
        parquetMonthsRebuilt: priceMonths.size + (newAlerts.length ? 1 : 0),
        sydneyStations,
    };
}

export const handler = async (event?: { atTime?: string }) => {
    const t = event?.atTime ? Date.parse(event.atTime) : Date.now();
    if (Number.isNaN(t)) throw new Error(`Invalid atTime: ${event?.atTime}`);
    const config = await loadConfig();
    try {
        const summary = await ingest(
            {
                store: new Store(process.env.DATA_BUCKET!),
                fetchPrices: () => fetchNswPrices({ apiKey: config.nswApiKey, basicAuth: config.nswApiBasicAuth }),
                sendAlertEmails,
            },
            t,
        );
        console.log('Ingest complete', JSON.stringify(summary));
        return summary;
    } catch (e) {
        console.error('Ingest failed', e);
        if (config.errorEmail) {
            const detail = e instanceof HttpError ? `${e.message}\n\n${e.body}` : e instanceof Error ? e.stack ?? e.message : String(e);
            await sendEmail(config.errorEmail, {
                subject: 'Fuel Price Alerts - Error fetching data',
                html: `<pre>${detail.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`,
                text: detail,
            }).catch((err) => console.error('Error sending error email', err));
        }
        throw e;
    }
};
