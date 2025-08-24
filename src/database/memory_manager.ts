// src/database/memory_manager.ts
import { GoogleGenAI } from '@google/genai';

// TypeScript interface for plan_tasks table
export interface PlanTaskRow {
    task_id: string;
    agent_id: string;
    plan_id: string;
    title: string;
    description: string;
    status: string;
    code_content?: string;
    created_at: string;
    updated_at: string;
    [key: string]: any; // For any additional columns
}
import { DatabaseService } from './services/DatabaseService.js';
import { ConversationHistoryManager } from './managers/ConversationHistoryManager.js';
import { ContextInformationManager } from './managers/ContextInformationManager.js';
import { ReferenceKeyManager } from './managers/ReferenceKeyManager.js';
import { PlanTaskManager } from './managers/PlanTaskManager.js';
import { SubtaskManager } from './managers/SubtaskManager.js';
import { KnowledgeGraphFactory, IKnowledgeGraphManager } from './factories/KnowledgeGraphFactory.js';
import { GeminiIntegrationService } from './services/GeminiIntegrationService.js';
import { GeminiPlannerService } from './services/GeminiPlannerService.js';
import { DatabaseUtilityService } from './services/DatabaseUtilityService.js';
import { CodebaseEmbeddingService } from './services/CodebaseEmbeddingService.js';
import { CodebaseContextRetrieverService } from './services/CodebaseContextRetrieverService.js'; // Import new service
import { initializeVectorStoreDatabase, getVectorStoreDb, closeVectorStoreDatabase } from './vector_db.js';
import BetterSqlite3 from 'better-sqlite3';

export class MemoryManager {
    private dbService!: DatabaseService;
    private vectorDb!: BetterSqlite3;
    public conversationHistoryManager!: ConversationHistoryManager;
    public contextInformationManager!: ContextInformationManager;
    public referenceKeyManager!: ReferenceKeyManager;
    public planTaskManager!: PlanTaskManager;
    public subtaskManager!: SubtaskManager;
    public knowledgeGraphManager!: IKnowledgeGraphManager;
    public geminiIntegrationService!: GeminiIntegrationService;
    public geminiPlannerService!: GeminiPlannerService;
    public codebaseEmbeddingService!: CodebaseEmbeddingService;
    public codebaseContextRetrieverService!: CodebaseContextRetrieverService;
    private databaseUtilityService!: DatabaseUtilityService;

    public projectRootPath: string = process.cwd();

    private constructor() {
        // Private constructor to enforce async factory
    }

    public getDbService(): DatabaseService {
        return this.dbService;
    }

    public getVectorDb(): BetterSqlite3 {
        if (!this.vectorDb) {
            throw new Error("Vector DB not initialized. Call MemoryManager.create() first.");
        }
        return this.vectorDb;
    }

    public getContextInformationManager(): ContextInformationManager {
        return this.contextInformationManager;
    }

    public getGeminiIntegrationService(): GeminiIntegrationService {
        return this.geminiIntegrationService;
    }

    public getGeminiPlannerService(): GeminiPlannerService {
        return this.geminiPlannerService;
    }

    public getCodebaseEmbeddingService(): CodebaseEmbeddingService {
        return this.codebaseEmbeddingService;
    }

    public getCodebaseContextRetrieverService(): CodebaseContextRetrieverService {
        return this.codebaseContextRetrieverService;
    }

    public static async create(projectRootPath?: string): Promise<MemoryManager> {
        const instance = new MemoryManager();
        if (projectRootPath) {
            instance.projectRootPath = projectRootPath;
        }
        await instance.init();
        return instance;
    }

    private async init() {
        this.dbService = await DatabaseService.create();
        this.vectorDb = await initializeVectorStoreDatabase();
        this.contextInformationManager = new ContextInformationManager(this.dbService);

        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        const genAIInstance = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : undefined;

        // Initialize services in the correct order
        // Initialize managers that don't depend on other services first
        this.conversationHistoryManager = new ConversationHistoryManager(this.dbService, null as any); // Temporarily null
        await this.conversationHistoryManager.initializeTables(); // Initialize conversation history manager with new functionality
        this.referenceKeyManager = new ReferenceKeyManager(this.dbService);
        this.planTaskManager = new PlanTaskManager(this.dbService);
        this.subtaskManager = new SubtaskManager(this.dbService);
        // Knowledge graph manager will be created later after GeminiIntegrationService is ready
        this.databaseUtilityService = new DatabaseUtilityService(this.dbService);

        // Now create GeminiIntegrationService
        this.geminiIntegrationService = new GeminiIntegrationService(
            this.dbService,
            this.contextInformationManager,
            this,
            genAIInstance
        );

        // Update managers that need GeminiIntegrationService
        this.conversationHistoryManager = new ConversationHistoryManager(this.dbService, this.geminiIntegrationService); // Update conversation history manager with gemini service after it's initialized

        // Create Knowledge Graph Manager using factory
        this.knowledgeGraphManager = await KnowledgeGraphFactory.create(this);

        // Create GeminiPlannerService
        this.geminiPlannerService = new GeminiPlannerService(this.geminiIntegrationService, this);

        // Create CodebaseEmbeddingService after GeminiIntegrationService is ready
        this.codebaseEmbeddingService = new CodebaseEmbeddingService(this, this.vectorDb as any, this.geminiIntegrationService);


        // Finally, create CodebaseContextRetrieverService after all dependencies are ready
        this.codebaseContextRetrieverService = new CodebaseContextRetrieverService(this);
    }

    public async closeAllDbConnections(): Promise<void> {
        if (this.dbService && this.dbService.getDb()) {
            try {
                await this.dbService.getDb().close();
                console.log("Main database connection closed.");
            } catch (e) {
                console.error("Error closing main database:", e);
            }
        }
        await closeVectorStoreDatabase();
    }

    // --- Conversation Sessions ---
    async createConversationSession(...args: Parameters<ConversationHistoryManager['createConversationSession']>) {
        return this.conversationHistoryManager.createConversationSession(...args);
    }

    async endConversationSession(...args: Parameters<ConversationHistoryManager['endConversationSession']>) {
        return this.conversationHistoryManager.endConversationSession(...args);
    }

    async getConversationSession(...args: Parameters<ConversationHistoryManager['getConversationSession']>) {
        return this.conversationHistoryManager.getConversationSession(...args);
    }

    async getConversationSessions(...args: Parameters<ConversationHistoryManager['getConversationSessions']>) {
        return this.conversationHistoryManager.getConversationSessions(...args);
    }

    // --- Conversation Messages ---
    async storeConversationMessage(...args: Parameters<ConversationHistoryManager['storeConversationMessage']>) {
        return this.conversationHistoryManager.storeConversationMessage(...args);
    }

    async storeConversationMessagesBulk(...args: Parameters<ConversationHistoryManager['storeConversationMessagesBulk']>) {
        return this.conversationHistoryManager.storeConversationMessagesBulk(...args);
    }

    async getConversationMessages(...args: Parameters<ConversationHistoryManager['getConversationMessages']>) {
        return this.conversationHistoryManager.getConversationMessages(...args);
    }

    async getMessageThread(...args: Parameters<ConversationHistoryManager['getMessageThread']>) {
        return this.conversationHistoryManager.getMessageThread(...args);
    }

    async updateMessageMetadata(...args: Parameters<ConversationHistoryManager['updateMessageMetadata']>) {
        return this.conversationHistoryManager.updateMessageMetadata(...args);
    }

    async deleteConversationSession(...args: Parameters<ConversationHistoryManager['deleteConversationSession']>) {
        return this.conversationHistoryManager.deleteConversationSession(...args);
    }

    // --- Conversation Participants (New) ---
    async addParticipantToSession(...args: Parameters<ConversationHistoryManager['addParticipantToSession']>) {
        return this.conversationHistoryManager.addParticipantToSession(...args);
    }

    async removeParticipantFromSession(...args: Parameters<ConversationHistoryManager['removeParticipantFromSession']>) {
        return this.conversationHistoryManager.removeParticipantFromSession(...args);
    }

    async getSessionParticipants(...args: Parameters<ConversationHistoryManager['getSessionParticipants']>) {
        return this.conversationHistoryManager.getSessionParticipants(...args);
    }

    // --- Conversation Search ---
    async searchConversations(...args: Parameters<ConversationHistoryManager['searchConversations']>) {
        return this.conversationHistoryManager.searchConversations(...args);
    }

    // --- Context Information ---
    async storeContext(...args: Parameters<ContextInformationManager['storeContext']>) {
        return this.contextInformationManager.storeContext(...args);
    }
    async getContext(...args: Parameters<ContextInformationManager['getContext']>) {
        return this.contextInformationManager.getContext(...args);
    }
    async getAllContexts(...args: Parameters<ContextInformationManager['getAllContexts']>) {
        return this.contextInformationManager.getAllContexts(...args);
    }
    async searchContextByKeywords(...args: Parameters<ContextInformationManager['searchContextByKeywords']>) {
        return this.contextInformationManager.searchContextByKeywords(...args);
    }
    async pruneOldContext(...args: Parameters<ContextInformationManager['pruneOldContext']>) {
        return this.contextInformationManager.pruneOldContext(...args);
    }

    // --- Reference Keys ---
    async addReferenceKey(...args: Parameters<ReferenceKeyManager['addReferenceKey']>) {
        return this.referenceKeyManager.addReferenceKey(...args);
    }
    async getReferenceKeys(...args: Parameters<ReferenceKeyManager['getReferenceKeys']>) {
        return this.referenceKeyManager.getReferenceKeys(...args);
    }

    // --- Plan and Task Management ---
    async createPlanWithTasks(...args: Parameters<PlanTaskManager['createPlanWithTasks']>) {
        return this.planTaskManager.createPlanWithTasks(...args);
    }
    async getPlan(...args: Parameters<PlanTaskManager['getPlan']>) {
        return this.planTaskManager.getPlan(...args);
    }
    async getPlans(...args: Parameters<PlanTaskManager['getPlans']>) {
        return this.planTaskManager.getPlans(...args);
    }
    async getPlanTasks(...args: Parameters<PlanTaskManager['getPlanTasks']>) {
        return this.planTaskManager.getPlanTasks(...args);
    }
    async updatePlanStatus(...args: Parameters<PlanTaskManager['updatePlanStatus']>) {
        return this.planTaskManager.updatePlanStatus(...args);
    }
    async updateTaskDetails(...args: Parameters<PlanTaskManager['updateTaskDetails']>) {
        return this.planTaskManager.updateTaskDetails(...args);
    }
    async deletePlans(...args: Parameters<PlanTaskManager['deletePlans']>) {
        return this.planTaskManager.deletePlans(...args);
    }
    async deleteTasks(...args: Parameters<PlanTaskManager['deleteTasks']>) {
        return this.planTaskManager.deleteTasks(...args);
    }
    async deleteSubtasks(...args: Parameters<SubtaskManager['deleteSubtasks']>) {
        return this.subtaskManager.deleteSubtasks(...args);
    }
    async getTask(...args: Parameters<PlanTaskManager['getTask']>) {
        return this.planTaskManager.getTask(...args);
    }
    async addTaskToPlan(...args: Parameters<PlanTaskManager['addTaskToPlan']>) {
        return this.planTaskManager.addTaskToPlan(...args);
    }

    // --- Knowledge Graph ---
    async createEntities(...args: Parameters<IKnowledgeGraphManager['createEntities']>) {
        return this.knowledgeGraphManager.createEntities(...args);
    }
    async createRelations(...args: Parameters<IKnowledgeGraphManager['createRelations']>) {
        return this.knowledgeGraphManager.createRelations(...args);
    }
    async addObservations(...args: Parameters<IKnowledgeGraphManager['addObservations']>) {
        return this.knowledgeGraphManager.addObservations(...args);
    }
    async deleteEntities(...args: Parameters<IKnowledgeGraphManager['deleteEntities']>) {
        return this.knowledgeGraphManager.deleteEntities(...args);
    }
    async deleteObservations(...args: Parameters<IKnowledgeGraphManager['deleteObservations']>) {
        return this.knowledgeGraphManager.deleteObservations(...args);
    }
    async deleteRelations(...args: Parameters<IKnowledgeGraphManager['deleteRelations']>) {
        return this.knowledgeGraphManager.deleteRelations(...args);
    }
    async readGraph(...args: Parameters<IKnowledgeGraphManager['readGraph']>) {
        return this.knowledgeGraphManager.readGraph(...args);
    }
    async searchNodes(...args: Parameters<IKnowledgeGraphManager['searchNodes']>) {
        return this.knowledgeGraphManager.searchNodes(...args);
    }
    async openNodes(...args: Parameters<IKnowledgeGraphManager['openNodes']>) {
        return this.knowledgeGraphManager.openNodes(...args);
    }
    async queryNaturalLanguage(...args: Parameters<IKnowledgeGraphManager['queryNaturalLanguage']>) {
        return this.knowledgeGraphManager.queryNaturalLanguage(...args);
    }
    async inferRelations(...args: Parameters<IKnowledgeGraphManager['inferRelations']>) {
        return this.knowledgeGraphManager.inferRelations(...args);
    }
    async generateMermaidGraph(...args: Parameters<IKnowledgeGraphManager['generateMermaidGraph']>) {
        return this.knowledgeGraphManager.generateMermaidGraph(...args);
    }

    // --- Gemini Integration Service Methods (delegated) ---
    async summarizeContext(...args: Parameters<GeminiIntegrationService['summarizeContext']>) {
        return this.geminiIntegrationService.summarizeContext(...args);
    }
    async extractEntities(...args: Parameters<GeminiIntegrationService['extractEntities']>) {
        return this.geminiIntegrationService.extractEntities(...args);
    }
    async semanticSearchContext(...args: Parameters<GeminiIntegrationService['semanticSearchContext']>) {
        return this.geminiIntegrationService.semanticSearchContext(...args);
    }

    async storeRefinedPrompt(...args: Parameters<GeminiIntegrationService['storeRefinedPrompt']>) {
        return this.geminiIntegrationService.storeRefinedPrompt(...args);
    }

    // --- Plan Task Accessors for tools ---

    /**
     * Retrieve a single task by ID for an agent.
     * Thin wrapper over PlanTaskManager/db layer to support get_task_details tool.
     */
    async getPlanTaskById(agent_id: string, task_id: string): Promise<PlanTaskRow | null> {
        // Ensure the PlanTaskManager is available
        if (!this.planTaskManager) {
            throw new Error('PlanTaskManager not initialized in MemoryManager.');
        }

        // Use DatabaseService to fetch the row to avoid tight coupling to manager internals.
        const sql = 'SELECT * FROM plan_tasks WHERE agent_id = ? AND task_id = ?';
        const db = await this.dbService.getDb();
        const row = await db.get(sql, agent_id, task_id);
        return row ? (row as PlanTaskRow) : null;
    }
    async getRefinedPrompt(...args: Parameters<GeminiIntegrationService['getRefinedPrompt']>) {
        return this.geminiIntegrationService.getRefinedPrompt(...args);
    }

    // --- Database Utility ---
    async exportDataToCsv(...args: Parameters<DatabaseUtilityService['exportDataToCsv']>) {
        return this.databaseUtilityService.exportDataToCsv(...args);
    }
    async backupDatabase(...args: Parameters<DatabaseUtilityService['backupDatabase']>) {
        return this.databaseUtilityService.backupDatabase(...args);
    }
    async restoreDatabase(...args: Parameters<DatabaseUtilityService['restoreDatabase']>) {
        return this.databaseUtilityService.restoreDatabase(...args);
    }
}
