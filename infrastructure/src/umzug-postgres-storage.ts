// MODIFIED from https://github.com/windfish-studio/umzug-postgres-storage/blob/master/src/umzug-postgres-storage.js

class UmzugPostgresStorage {
    client: {query: (sql: string, params?: any[]) => Promise<{records: any[]}>};
    table: string;
    column: string;

    constructor({client, table = 'migrations', column = 'name'}: {client: {query: (sql: string, params?: any[]) => Promise<{records: any[]}>}, table?: string, column?: string}){
        this.client = client;
        this.table = table;
        this.column = column;
        client.query(`
            CREATE TABLE IF NOT EXISTS ${this.table} (
                "${this.column}" TEXT UNIQUE
            );
        `);
    }

    async logMigration(migrationName: string) {
        await this.client.query(`
            INSERT INTO ${this.table} ("${this.column}") 
                VALUES ($1)
            ON CONFLICT DO NOTHING
        `, [migrationName]);
    }

    async unlogMigration(migrationName: string) {
        await this.client.query(`
            DELETE FROM ${this.table} 
            WHERE "${this.column}" = $1
        `, [migrationName]);
    }

    executed() {
        return this.client.query(`
            SELECT "${this.column}" 
            FROM ${this.table}  
            ORDER BY "${this.column}" ASC;
        `).then((result) => 
            result.records.map((row) => row[this.column])
        );
    }

}

export default UmzugPostgresStorage;