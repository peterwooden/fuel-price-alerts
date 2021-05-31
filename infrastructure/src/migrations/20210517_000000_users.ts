module.exports = {
    up: async (client: any) => {
        return client.query(`
            CREATE TABLE users (
                uuid UUID PRIMARY KEY,
                email TEXT NOT NULL,
                password TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                active BOOLEAN
            );

            CREATE TABLE users_stations_fuels (
                user_uuid UUID NOT NULL REFERENCES users,
                station_code TEXT NOT NULL REFERENCES stations,
                fuel_type TEXT NOT NULL
            );
        `);
    },
    down: async (client: any) => {
        return client.query(`
            DROP TABLE users_stations_fuels;
            DROP TABLE users;
        `);
    }
}