module.exports = {
    up: async (client: any) => {
        return client.query(`
            CREATE INDEX idx_prices_timestamp ON prices ("timestamp");
            CREATE INDEX idx_prices_station_code_fuel_type_timestamp ON prices (station_code, fuel_type, "timestamp");
        `);
    },
    down: async (client: any) => {
        return client.query(`
            DROP INDEX idx_prices_station_code_fuel_type_timestamp;
            DROP INDEX idx_prices_timestamp;
        `);
    }
}