// Recent Sydney prices from the public API (backend/src/sydney-prices.ts builds the file).

export interface Station {
    code: string;
    name: string;
    brand: string;
    lat: number;
    lng: number;
}

/** One station's prices for one fuel: times in epoch ms (ascending), prices in c/L. */
export interface Series {
    station: number;
    times: number[];
    prices: number[];
}

export interface PriceData {
    from: number;
    to: number;
    generatedAt: number;
    stations: Station[];
    fuels: Record<string, Series[]>;
}

/** The wire format; see SydneyPrices in backend/src/sydney-prices.ts. */
export interface SydneyPricesFile {
    version: 1;
    generatedAt: string;
    from: string;
    to: string;
    stations: Station[];
    series: Record<string, [number, number[]][]>;
}

const MINUTE = 60 * 1000;

export function decodePrices(file: SydneyPricesFile): PriceData {
    const from = Date.parse(file.from);
    const fuels: Record<string, Series[]> = {};
    for (const [fuel, entries] of Object.entries(file.series)) {
        fuels[fuel] = entries.map(([station, flat]) => {
            const times: number[] = [];
            const prices: number[] = [];
            for (let i = 0; i < flat.length; i += 2) {
                const t = from + flat[i] * MINUTE;
                // Two updates within the same minute: keep the later one.
                if (times.length && times[times.length - 1] === t) prices[prices.length - 1] = flat[i + 1] / 10;
                else {
                    times.push(t);
                    prices.push(flat[i + 1] / 10);
                }
            }
            return { station, times, prices };
        });
    }
    return { from, to: Date.parse(file.to), generatedAt: Date.parse(file.generatedAt), stations: file.stations, fuels };
}

export async function loadPrices(url: string): Promise<PriceData> {
    const res = await fetch(url);
    if (res.status === 404) throw new Error('The price data has not been published yet. It is rebuilt every two hours.');
    if (!res.ok) throw new Error(`Could not load prices (HTTP ${res.status}).`);
    return decodePrices(await res.json());
}
