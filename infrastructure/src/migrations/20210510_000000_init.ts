module.exports = {
    up: async (client: any) => {
        return client.query(`
            CREATE TABLE stations (
                brand_id TEXT,
                station_id TEXT,
                brand TEXT,
                code TEXT PRIMARY KEY,
                name TEXT,
                address TEXT,
                latitude FLOAT8,
                longitude FLOAT8,
                state TEXT
            );
            
            CREATE TABLE prices (
                station_code TEXT REFERENCES stations,
                state TEXT,
                fuel_type TEXT,
                price DECIMAL,
                timestamp TIMESTAMPTZ,
                UNIQUE(station_code, fuel_type, timestamp)
            );
        `);
    },
    down: async (client: any) => {
        return client.query(`
            DROP TABLE stations;
            DROP TABLE prices;
        `);
    }
}