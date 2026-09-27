// Serves the public, derived files under public/ in the data bucket, without authentication.
// Served by a Lambda Function URL that can only read public/*; CORS is handled by the URL
// configuration. Files are stored gzipped and passed through as-is.

import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import { keys, Store } from './store';

const FILES: Record<string, string> = {
    '/sydney-prices.json': keys.sydneyPrices,
};

const text = (statusCode: number, body: string): APIGatewayProxyStructuredResultV2 => ({
    statusCode,
    headers: { 'Content-Type': 'text/plain' },
    body,
});

export async function servePublicFile(store: Store, method: string, path: string): Promise<APIGatewayProxyStructuredResultV2> {
    if (method !== 'GET') return text(405, 'Method not allowed.');
    const key = FILES[path];
    if (!key) return text(404, 'Not found.');

    try {
        const file = await store.getBytes(key);
        // Written by ingest; missing only until the first run after it is deployed.
        if (!file) return text(404, 'Not built yet.');
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
                // Ingest rewrites the file every two hours.
                'Cache-Control': 'public, max-age=900',
            },
            body: Buffer.from(file.value).toString('base64'),
            isBase64Encoded: true,
        };
    } catch (e) {
        console.error('Public file request failed', e);
        return text(500, 'Internal error.');
    }
}

let store: Store | undefined;

export const handler = (event: LambdaFunctionURLEvent) =>
    servePublicFile((store ??= new Store(process.env.DATA_BUCKET!)), event.requestContext.http.method, event.rawPath);
