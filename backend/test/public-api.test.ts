import { gunzipSync } from 'zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { servePublicFile } from '../src/public-api';
import { keys, Store } from '../src/store';
import { FakeS3 } from './fake-s3';

describe('public API', () => {
    let s3: FakeS3;
    let store: Store;

    beforeEach(() => {
        s3 = new FakeS3();
        store = new Store('bucket', s3.asClient());
    });

    it('serves the Sydney prices file gzipped, exactly as stored', async () => {
        await store.putJson(keys.sydneyPrices, { version: 1 });
        const res = await servePublicFile(store, 'GET', '/sydney-prices.json');
        expect(res).toMatchObject({
            statusCode: 200,
            isBase64Encoded: true,
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        });
        expect(JSON.parse(gunzipSync(Buffer.from(res.body!, 'base64')).toString())).toEqual({ version: 1 });
    });

    it('says when the file has not been built yet', async () => {
        expect(await servePublicFile(store, 'GET', '/sydney-prices.json')).toMatchObject({ statusCode: 404, body: 'Not built yet.' });
    });

    it('serves nothing else from the bucket', async () => {
        await store.putSubscription('user-1', { email: 'driver@example.com', fuelType: 'U91', stations: [], updatedAt: '' });
        for (const path of ['/subscriptions/user-1.json', '/state.json.gz', '/', '/../state.json.gz']) {
            expect((await servePublicFile(store, 'GET', path)).statusCode).toBe(404);
        }
        expect((await servePublicFile(store, 'POST', '/sydney-prices.json')).statusCode).toBe(405);
    });
});
