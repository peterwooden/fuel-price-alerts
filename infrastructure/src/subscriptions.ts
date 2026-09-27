// GET/POST a user's alert subscription. Served by a Lambda Function URL; CORS is handled
// by the URL configuration. Callers authenticate with their Cognito ID token.

import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { Store } from './store';

const MAX_STATIONS = 5;

const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID!,
    clientId: process.env.USER_POOL_CLIENT_ID!,
    tokenUse: 'id',
});

const store = new Store(process.env.DATA_BUCKET!);

const respond = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
    statusCode,
    headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});

export function parseSubscriptionBody(body: string | undefined): { fuelType: string; stations: string[] } | undefined {
    try {
        const { fuelType, stations } = JSON.parse(body ?? '');
        if (typeof fuelType !== 'string' || !/^[A-Z0-9]{1,10}$/.test(fuelType)) return undefined;
        if (!Array.isArray(stations) || stations.length > MAX_STATIONS) return undefined;
        const codes = stations.map(String);
        if (!codes.every((code) => /^[A-Za-z0-9-]{1,20}$/.test(code))) return undefined;
        return { fuelType, stations: [...new Set(codes)] };
    } catch {
        return undefined;
    }
}

export const handler = async (event: LambdaFunctionURLEvent): Promise<APIGatewayProxyStructuredResultV2> => {
    const [scheme, token] = (event.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) return respond(401, 'Unauthorized.');

    let claims: { sub: string; email?: unknown };
    try {
        claims = await verifier.verify(token);
    } catch {
        return respond(401, 'Unauthorized.');
    }

    try {
        switch (event.requestContext.http.method) {
            case 'GET': {
                const subscription = await store.getSubscription(claims.sub);
                const { fuelType, stations = [] } = subscription?.value ?? {};
                return respond(
                    200,
                    stations.map((stationCode) => ({ stationCode, fuelType })),
                );
            }
            case 'POST': {
                const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
                const parsed = parseSubscriptionBody(body);
                if (!parsed) return respond(400, 'Bad request.');
                if (typeof claims.email !== 'string') return respond(400, 'Token has no email.');
                await store.putSubscription(claims.sub, {
                    email: claims.email,
                    ...parsed,
                    updatedAt: new Date().toISOString(),
                });
                return respond(200, 'Success');
            }
            default:
                return respond(405, 'Method not allowed.');
        }
    } catch (e) {
        console.error('Subscription request failed', e);
        return respond(500, 'Internal error.');
    }
};
