import { getDatabase, initializeDatabase } from '../db.js';
import { Database } from 'sqlite';
import { ConversationHistoryManager } from '../managers/ConversationHistoryManager.js';
import { ContextInformationManager } from '../managers/ContextInformationManager.js';
import { ReferenceKeyManager } from '../managers/ReferenceKeyManager.js';
import { KnowledgeGraphManager } from '../managers/KnowledgeGraphManager.js';
import { PlanTaskManager } from '../managers/PlanTaskManager.js';
import { SubtaskManager } from '../managers/SubtaskManager.js';

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
        // Managers are now initialized and managed by MemoryManager, not DatabaseService
    }

    public getDb(): Database {
        return this.db;
    }
}
