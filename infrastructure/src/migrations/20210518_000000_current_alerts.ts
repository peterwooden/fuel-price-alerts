module.exports = {
    up: async (client: any) => {
        return client.query(`
            CREATE VIEW current_alerts AS 
            WITH recent_prices AS (
                SELECT 
                    prices.station_code, prices.fuel_type, prices.timestamp, prices.price
                FROM prices
                WHERE prices.timestamp >= NOW() - INTERVAL '1 week' AND prices.timestamp < NOW()
                
                UNION ALL -- Include the last price before the interval starts
                
                SELECT 
                    p1.station_code, 
                    p1.fuel_type, 
                    MAX(p1.timestamp),
                    (
                        SELECT p2.price
                        FROM prices p2
                        WHERE 
                            p2.station_code = p1.station_code
                            AND p2.fuel_type = p1.fuel_type
                            AND p2.timestamp = MAX(p1.timestamp)
                    )
                FROM prices p1
                WHERE p1.timestamp < NOW() - INTERVAL '1 week' 
                GROUP BY p1.station_code, p1.fuel_type
                /*( -- Less performant but simpler
                    SELECT DISTINCT ON (prices.station_code, prices.fuel_type)
                        prices.station_code, prices.fuel_type, prices.timestamp, prices.price
                    FROM prices
                    WHERE prices.timestamp < NOW() - INTERVAL '1 week'
                    ORDER BY prices.station_code, prices.fuel_type, prices.timestamp DESC
                )*/
            )
            SELECT
                stations.code,
                current_price.fuel_type,
                current_price.price,
                previous_week_average.time_weighted_average
            FROM stations
            JOIN (
                SELECT DISTINCT ON (prices.station_code, prices.fuel_type)
                    prices.station_code, prices.fuel_type, prices.timestamp, prices.price
                FROM recent_prices prices
                ORDER BY prices.station_code, prices.fuel_type, prices.timestamp DESC
            ) current_price ON current_price.station_code = stations.code
            JOIN (
                SELECT
                    subquery.station_code, 
                    subquery.fuel_type,
                    SUM(subquery.weighted_price) AS time_weighted_average
                FROM (
                    SELECT 
                        prices.station_code, 
                        prices.fuel_type,
                        (
                            EXTRACT(epoch FROM (
                                COALESCE(
                                    LEAD(prices.timestamp) OVER (PARTITION BY prices.station_code, prices.fuel_type ORDER BY prices.timestamp), 
                                    NOW()
                                ) 
                                - GREATEST(
                                    prices.timestamp, 
                                    NOW() - INTERVAL '1 week'
                                )
                            )) 
                            / EXTRACT(epoch FROM INTERVAL '1 week') 
                            * price
                        ) AS weighted_price
                    FROM recent_prices prices
                ) subquery
                GROUP BY subquery.station_code, subquery.fuel_type
            ) previous_week_average 
            ON previous_week_average.station_code = stations.code AND previous_week_average.fuel_type = current_price.fuel_type
            WHERE 
                current_price.price > 1.05 * previous_week_average.time_weighted_average 
        `);
    },
    down: async (client: any) => {
        return client.query(`
            DROP VIEW current_alerts;
        `);
    }
}