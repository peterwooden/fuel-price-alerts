import axios from 'axios';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { Client } from './rds';

const { API_NSW_APIKEY, API_NSW_BASICAUTH, AWS_REGION, EMAIL_LOG } =
    process.env;

const sesClient = new SESClient({ region: AWS_REGION });

export const handler = async (event: any) => {
    try {
        console.log('Connecting to DB...');

        const client = await Client();

        console.log('Acquiring access_token from NSW API...');

        const { access_token } = (
            await axios({
                method: 'get',
                url: 'https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials',
                headers: {
                    accept: 'application/json',
                    Authorization: 'Basic ' + API_NSW_BASICAUTH,
                },
            })
        ).data;

        console.log('Acquired access_token from NSW API');

        const {
            data: { stations, prices },
        }: {
            data: {
                stations: {
                    brandid: string;
                    stationid: string;
                    brand: string;
                    code: string;
                    name: string;
                    address: string;
                    location: { latitude: string; longitude: string };
                    state: string;
                }[];
                prices: {
                    stationcode: string;
                    state: string;
                    fueltype: string;
                    price: string;
                    lastupdated: string;
                }[];
            };
        } = await axios({
            method: 'get',
            url: 'https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices?states=NSW',
            headers: {
                accept: 'application/json',
                Authorization: `Bearer ${access_token}`,
                'Content-Type': 'application/json; charset=utf-8',
                apikey: API_NSW_APIKEY,
                transactionid: '12345',
                requesttimestamp: '12/04/2021 08:37:00 AM',
            },
        });

        console.log('Inserting stations data...');

        await client.query(
            `
                INSERT INTO stations (brand_id, station_id, brand, code, name, address, latitude, longitude, state) 
                VALUES (:brandid, :stationid, :brand, :code, :name, :address, :latitude, :longitude, :state)
                ON CONFLICT (code)
                DO UPDATE SET 
                    brand_id = EXCLUDED.brand_id,
                    station_id = EXCLUDED.station_id,
                    brand = EXCLUDED.brand,
                    name = EXCLUDED.name,
                    address = EXCLUDED.address,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    state = EXCLUDED.state
            `,
            stations.map(
                ({
                    brandid,
                    stationid,
                    brand,
                    code,
                    name,
                    address,
                    location: { latitude, longitude },
                    state,
                }) => [
                    {
                        brandid,
                        stationid,
                        brand,
                        code,
                        name,
                        address,
                        latitude,
                        longitude,
                        state,
                    },
                ]
            )
        );

        console.log('Inserting prices data...');

        await client.query(
            `
                INSERT INTO prices (station_code, state, fuel_type, price, timestamp) 
                VALUES (:stationcode, :state, :fueltype, :price, (:timestamp)::timestamptz)
                ON CONFLICT DO NOTHING
            `,
            prices.map(
                ({ stationcode, state, fueltype, price, lastupdated }) => {
                    const { day, month, year, time } =
                        /(?<day>\d{2})\/(?<month>\d{2})\/(?<year>\d{4}) (?<time>.*)/.exec(
                            lastupdated
                        )?.groups as {
                            day: string;
                            month: string;
                            year: string;
                            time: string;
                        };
                    return [
                        {
                            stationcode,
                            state,
                            fueltype,
                            price,
                            timestamp: `${year}-${month}-${day}T${time}Z`,
                        },
                    ];
                }
            )
        );

        console.log('Successfully inserted all data.');

        const atTime = event?.atTime || 'NOW()';

        console.log(`Getting alerts at time: ${atTime}`);

        const result = await client.query(`
            SELECT 
                u.email AS "email",
                json_agg(json_build_object(
                    'stationName', s.name,
                    'fuelType', trends.fuel_type,
                    'price', trends.price,
                    'timeWeightedPrice', trends.time_weighted_average,
                    'changePercent', trends.change * 100,
                    'recentPrices', trends.prices
                ) ORDER BY trends.change DESC) AS "alerts"
            FROM get_price_trends_at_time(${atTime}) as trends
            JOIN users_stations_fuels usf ON usf.station_code = trends.code AND usf.fuel_type = trends.fuel_type
            JOIN users u ON u.uuid = usf.user_uuid
            JOIN stations s ON s.code = trends.code
            LEFT JOIN previous_alerts pa ON pa.station_code = trends.code AND pa.fuel_type = trends.fuel_type AND ${atTime} - INTERVAL '1 week' < pa.time AND pa.time <= ${atTime}
            WHERE pa.station_code IS NULL
            GROUP BY u.uuid
            HAVING MAX(trends.change) > 0.05
        `);

        await client.query(`
            INSERT INTO previous_alerts
            SELECT
                trends.code AS station_code,
                trends.fuel_type AS fuel_type,
                ${atTime} as time
            FROM get_price_trends_at_time(${atTime}) as trends
            LEFT JOIN previous_alerts pa ON pa.station_code = trends.code AND pa.fuel_type = trends.fuel_type AND ${atTime} - INTERVAL '1 week' < pa.time AND pa.time <= ${atTime}
            WHERE pa.station_code IS NULL AND trends.change > 0.05
        `);

        const {
            records,
        }: {
            records: {
                email: string;
                alerts: string;
            }[];
        } = result;

        console.log('Records received', JSON.stringify(records));

        // TODO: Make these serial and throttled to 14/second and 50k/day
        records.forEach(async ({ email, alerts }) => {
            // Set the parameters
            const params = {
                Destination: {
                    ToAddresses: [email],
                },
                Message: {
                    /* required */
                    Body: {
                        /* required */
                        Html: {
                            Charset: 'UTF-8',
                            Data: `
                                <table>
                                    <tr>
                                        <th>Station</th>
                                        <th>Fuel Type</th>
                                        <th>Current Price</th>
                                        <th>Past Week Average</th>
                                        <th>% Change</th>
                                    </tr>
                                    ${(
                                        JSON.parse(alerts) as {
                                            stationName: string;
                                            fuelType: string;
                                            price: number;
                                            timeWeightedPrice: number;
                                            changePercent: number;
                                            recentPrices: {
                                                time: string;
                                                price: number;
                                            }[];
                                        }[]
                                    ).map(
                                        (alert) => `<tr>
                                        <td>${alert.stationName}</td>
                                        <td>${alert.fuelType}</td>
                                        <td>${alert.price.toFixed(1)}</td>
                                        <td>${alert.timeWeightedPrice.toFixed(
                                            1
                                        )}</td>
                                        <td>${alert.changePercent.toFixed(
                                            1
                                        )}</td>
                                    </tr>`
                                    )}
                                </table>
                            `,
                        },
                        Text: {
                            Charset: 'UTF-8',
                            Data: JSON.stringify(alerts),
                        },
                    },
                    Subject: {
                        Charset: 'UTF-8',
                        Data: 'Fuel Price Alert',
                    },
                },
                Source: 'fuel-alerts@peterwooden.com', // SENDER_ADDRESS
                ReplyToAddresses: [],
            };

            try {
                const data = await sesClient.send(new SendEmailCommand(params));
                console.log('Success', data);
                //return data; // For unit tests.
            } catch (err) {
                console.log('Error', err);
            }
        });

        console.log(JSON.stringify(result));
    } catch (e) {
        console.log('Error:', e);
    }

    console.log('Finished.');

    const response = {
        statusCode: 200,
        body: JSON.stringify('Success'),
    };
    return response;
};
