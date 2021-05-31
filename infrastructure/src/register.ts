import { Client } from './rds';

export const handler = async (event: any, context: any) => {
    try {
        
        console.log('Connecting to DB...');

        const client = await Client();

        
    } catch (e) {

    }
}