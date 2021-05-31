import * as path from 'path';
import * as Umzug from 'umzug';
import UmzugPostgresStorage from './umzug-postgres-storage';
import DataApiClient = require("data-api-client")

export const Client = async () => {
    const client = DataApiClient({
        secretArn: process.env.SECRET_ARN || '',
        resourceArn: process.env.CLUSTER_ARN || '',
        database: process.env.DB_NAME,
        engine: 'pg'
    } as {secretArn: string, resourceArn: string, database: string});

    const umzug = new Umzug({
        storage: new UmzugPostgresStorage({ client }),
        migrations: {
            path: path.join(__dirname, './migrations'),
            params: [client],
        },
    });

    await umzug.up();

    return client as { query: (sql: string, params?: [] | unknown) => Promise<{ records: any[] }>};
}