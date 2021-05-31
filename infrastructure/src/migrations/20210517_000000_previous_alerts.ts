module.exports = {
    up: async (client: any) => {
        return client.query(`
            CREATE TABLE previous_alerts (
                station_code TEXT NOT NULL REFERENCES stations,
                fuel_type TEXT NOT NULL,
                time TIMESTAMPTZ NOT NULL
            );
            CREATE INDEX idx_previous_alerts_station_code_fuel_type_timestamp ON previous_alerts (station_code, fuel_type, time);
        `);
    },
    down: async (client: any) => {
        return client.query(`
            DROP INDEX idx_previous_alerts_station_code_fuel_type_timestamp;
            DROP TABLE previous_alerts;
        `);
    }
}