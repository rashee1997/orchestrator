import { getDatabase, initializeDatabase } from '../db.js';
import { Database } from 'sqlite';

export class DatabaseService {
    private db!: Database;

    constructor() {
        // Private constructor to enforce async factory
    }

    public static async create(): Promise<DatabaseService> {
        const instance = new DatabaseService();
        await instance.init();
        return instance;
    }

    private async init() {
        this.db = await initializeDatabase();
    }

    public getDb(): Database {
        return this.db;
    }
}
