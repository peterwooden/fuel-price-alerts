// Client for the NSW FuelCheck API (https://api.nsw.gov.au/Product/Index/22).

export interface NswStation {
    brandid: string;
    stationid: string;
    brand: string;
    code: string | number;
    name: string;
    address: string;
    location: { latitude: string | number; longitude: string | number };
    state: string;
}

export interface NswPrice {
    stationcode: string | number;
    state: string;
    fueltype: string;
    price: string | number;
    lastupdated: string;
}

export class HttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body: string,
    ) {
        super(`${message}: HTTP ${status} ${body.slice(0, 500)}`);
    }
}

async function getJson<T>(url: string, init: RequestInit, what: string): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new HttpError(what, res.status, await res.text());
    return (await res.json()) as T;
}

export async function fetchNswPrices({ apiKey, basicAuth }: { apiKey: string; basicAuth: string }) {
    const { access_token } = await getJson<{ access_token: string }>(
        'https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials',
        { headers: { accept: 'application/json', Authorization: `Basic ${basicAuth}` } },
        'NSW API token request failed',
    );

    return getJson<{ stations: NswStation[]; prices: NswPrice[] }>(
        'https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices?states=NSW',
        {
            headers: {
                accept: 'application/json',
                Authorization: `Bearer ${access_token}`,
                'Content-Type': 'application/json; charset=utf-8',
                apikey: apiKey,
                transactionid: '12345',
                requesttimestamp: '12/04/2021 08:37:00 AM',
            },
        },
        'NSW API prices request failed',
    );
}

/** "26/09/2026 23:06:45" -> "2026-09-26T23:06:45Z" (the API reports UTC wall-clock time). */
export function parseNswTimestamp(lastupdated: string): string {
    const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(lastupdated.trim());
    if (!match) throw new Error(`Unrecognised lastupdated timestamp: ${lastupdated}`);
    const [, day, month, year, hh, mm, ss = '00'] = match;
    return `${year}-${month}-${day}T${hh.padStart(2, '0')}:${mm}:${ss}Z`;
}
