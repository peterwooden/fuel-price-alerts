module.exports = {
    up: async (client: any) => {
        return client.query(`
            CREATE FUNCTION get_price_trends_at_time (t TIMESTAMPTZ) RETURNS TABLE(code TEXT, fuel_type TEXT, price NUMERIC, time_weighted_average NUMERIC, change NUMERIC, prices JSONB)
            STABLE
            LANGUAGE SQL
            AS $$
                -- Get all prices in past week and the last one prior
                WITH recent_prices AS (
                    SELECT 
                        prices.station_code, prices.fuel_type, prices.timestamp, prices.price
                    FROM prices
                    WHERE prices.timestamp >= t - INTERVAL '1 week' AND prices.timestamp < t
            
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
                    WHERE p1.timestamp < t - INTERVAL '1 week' 
                    GROUP BY p1.station_code, p1.fuel_type
                    /*( -- Less performant but simpler
                        SELECT DISTINCT ON (prices.station_code, prices.fuel_type)
                        prices.station_code, prices.fuel_type, prices.timestamp, prices.price
                        FROM prices
                        WHERE prices.timestamp < t - INTERVAL '1 week'
                        ORDER BY prices.station_code, prices.fuel_type, prices.timestamp DESC
                    )*/
                )
                SELECT 
                    stations.code::TEXT AS code, 
                    current_price.fuel_type::TEXT AS fuel_type, 
                    current_price.price::NUMERIC AS price, 
                    previous_week_average.time_weighted_average::NUMERIC AS time_weighted_average,
					((current_price.price - previous_week_average.time_weighted_average) / GREATEST(previous_week_average.time_weighted_average, 1))::NUMERIC AS change,
                    price_list.prices AS prices
                FROM stations
                JOIN ( -- Get current price per station per fuel_type
                    SELECT DISTINCT ON (prices.station_code, prices.fuel_type)
                        prices.station_code, prices.fuel_type, prices.timestamp, prices.price
                    FROM recent_prices prices
                    ORDER BY prices.station_code, prices.fuel_type, prices.timestamp DESC
                ) current_price ON current_price.station_code = stations.code
                JOIN ( -- Get previous week average per station per fuel_type
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
                                    t
                                ) 
                                - GREATEST(
                                    prices.timestamp, 
                                    t - INTERVAL '1 week'
                                )
                                )) 
                                / EXTRACT(epoch FROM INTERVAL '1 week') 
                                * price
                            ) AS weighted_price
                        FROM recent_prices prices
                    ) subquery
                    GROUP BY subquery.station_code, subquery.fuel_type
                ) previous_week_average ON previous_week_average.station_code = stations.code AND previous_week_average.fuel_type = current_price.fuel_type
				JOIN ( -- Make list of recent prices
					SELECT
						jsonb_agg(json_build_object(
							'time', rp.timestamp,
							'price', rp.price
						) ORDER BY rp.timestamp) AS prices,
						rp.station_code,
						rp.fuel_type
					FROM recent_prices rp
					GROUP BY rp.station_code, rp.fuel_type
				) price_list ON price_list.station_code = stations.code AND price_list.fuel_type = current_price.fuel_type
            $$;
        `);
    },
    down: async (client: any) => {
        return client.query(`
            DROP FUNCTION get_price_trends_at_time;
        `);
    }
}