import { Client } from './rds';
import DecodeVerifyJwt from './decode-verify-jwt';
import { APIGatewayProxyHandler } from 'aws-lambda';

const headers = {
    'Access-Control-Allow-Origin': '*', // Required for CORS support to work
    'Access-Control-Allow-Credentials': true, // Required for cookies, authorization headers with HTTPS
};

export const handler: APIGatewayProxyHandler = async (event) => {
    try {
        const token = event.headers.Authorization?.split(' ');
        if (!token || token[0] !== 'Bearer' || !token[1]) {
            return {
                headers,
                statusCode: 401,
                body: 'Unauthorized.',
            };
        }

        const decoded = await DecodeVerifyJwt({ token: token[1] });

        if (!decoded.isValid || !decoded.claims.sub) {
            return {
                headers,
                statusCode: 401,
                body: 'Unauthorized.',
            };
        }

        if (event.httpMethod === 'POST') {
            let fuelType: string, stations: string[];
            try {
                ({ fuelType, stations } = JSON.parse(event.body || ''));

                if (stations.length > 5)
                    throw new Error('Not allowed to track more than 5 stations.');
            } catch (e) {
                return {
                    headers,
                    statusCode: 400,
                    body: 'Bad request.',
                };
            }

            const client = await Client();

            await client.query(
                `
                INSERT INTO users (uuid, email) VALUES ((:uuid)::UUID, :email) ON CONFLICT DO NOTHING;
                DELETE FROM users_stations_fuels WHERE user_uuid = (:uuid)::UUID;
            `,
                { uuid: decoded.claims.sub, email: decoded.claims.email }
            );

            await client.query(
                `INSERT INTO users_stations_fuels (user_uuid, station_code, fuel_type) VALUES ((:uuid)::UUID, :station_code, :fuel_type)`,
                stations.map((station_code) => [
                    {
                        uuid: decoded.claims.sub,
                        station_code,
                        fuel_type: fuelType,
                    },
                ])
            );

            return {
                headers,
                statusCode: 200,
                body: 'Success',
            };
        } else if (event.httpMethod === 'GET') {
            const client = await Client();

            const {
                records,
            }: { records: { stationCode: string; fuelType: string }[] } =
                await client.query(
                    `SELECT station_code AS "stationCode", fuel_type AS "fuelType" FROM users_stations_fuels WHERE user_uuid = (:uuid)::UUID`,
                    { uuid: decoded.claims.sub }
                );

            return {
                headers,
                statusCode: 200,
                body: JSON.stringify(records),
            };
        } else {
            return {
                headers,
                statusCode: 405,
                body: 'Method not allowed.',
            };
        }
    } catch (e) {
        console.log(`Error: ${e}`);
        return {
            headers,
            statusCode: 500,
            body: 'Internal error.',
        };
    }
};
