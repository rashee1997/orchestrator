import { getDatabase, initializeDatabase } from '../db.js';
import { Database } from 'sqlite';
import { ConversationHistoryManager } from '../managers/ConversationHistoryManager.js';
import { ContextInformationManager } from '../managers/ContextInformationManager.js';
import { ReferenceKeyManager } from '../managers/ReferenceKeyManager.js';
import { SourceAttributionManager } from '../managers/SourceAttributionManager.js';
import { CorrectionLogManager } from '../managers/CorrectionLogManager.js';
import { SuccessMetricsManager } from '../managers/SuccessMetricsManager.js';
import { KnowledgeGraphManager } from '../managers/KnowledgeGraphManager.js';
import { PlanTaskManager } from '../managers/PlanTaskManager.js';
import { SubtaskManager } from '../managers/SubtaskManager.js';

export class DatabaseService {
    private db!: Database;
    public conversationHistoryManager!: ConversationHistoryManager;
    public contextInformationManager!: ContextInformationManager;
    public referenceKeyManager!: ReferenceKeyManager;
    public sourceAttributionManager!: SourceAttributionManager;
    public correctionLogManager!: CorrectionLogManager;
    public successMetricsManager!: SuccessMetricsManager;
    public knowledgeGraphManager!: KnowledgeGraphManager;
    public planTaskManager!: PlanTaskManager;
    public subtaskManager!: SubtaskManager;

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
        this.conversationHistoryManager = new ConversationHistoryManager(this);
        this.contextInformationManager = new ContextInformationManager(this);
        this.referenceKeyManager = new ReferenceKeyManager(this);
        this.sourceAttributionManager = new SourceAttributionManager(this);
        this.correctionLogManager = new CorrectionLogManager(this);
        this.successMetricsManager = new SuccessMetricsManager(this);
        this.knowledgeGraphManager = new KnowledgeGraphManager(this);
        this.planTaskManager = new PlanTaskManager(this);
        this.subtaskManager = new SubtaskManager(this);
    }

    public getDb(): Database {
        return this.db;
    }
}
