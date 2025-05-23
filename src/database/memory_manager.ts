import { GoogleGenAI } from '@google/genai';
import { DatabaseService } from './services/DatabaseService.js';
import { ConversationHistoryManager } from './managers/ConversationHistoryManager.js';
import { ContextInformationManager } from './managers/ContextInformationManager.js';
import { ReferenceKeyManager } from './managers/ReferenceKeyManager.js';
import { SourceAttributionManager } from './managers/SourceAttributionManager.js';
import { CorrectionLogManager } from './managers/CorrectionLogManager.js';
import { SuccessMetricsManager } from './managers/SuccessMetricsManager.js';
import { PlanTaskManager } from './managers/PlanTaskManager.js';
import { KnowledgeGraphManager } from './managers/KnowledgeGraphManager.js';
import { GeminiIntegrationService } from './services/GeminiIntegrationService.js';
import { DatabaseUtilityService } from './services/DatabaseUtilityService.js';

export class MemoryManager {
    private dbService!: DatabaseService;
    private conversationHistoryManager!: ConversationHistoryManager;
    private contextInformationManager!: ContextInformationManager;
    private referenceKeyManager!: ReferenceKeyManager;
    private sourceAttributionManager!: SourceAttributionManager;
    private correctionLogManager!: CorrectionLogManager;
    private successMetricsManager!: SuccessMetricsManager;
    private planTaskManager!: PlanTaskManager;
    private knowledgeGraphManager!: KnowledgeGraphManager;
    private geminiIntegrationService!: GeminiIntegrationService;
    private databaseUtilityService!: DatabaseUtilityService;

    private constructor() {
        // Private constructor to enforce async factory
    }

    public static async create(): Promise<MemoryManager> {
        const instance = new MemoryManager();
        await instance.init();
        return instance;
    }

    private async init() {
        this.dbService = await DatabaseService.create();

        // Initialize managers with DatabaseService dependency
        this.conversationHistoryManager = new ConversationHistoryManager(this.dbService);
        this.contextInformationManager = new ContextInformationManager(this.dbService);
        this.referenceKeyManager = new ReferenceKeyManager(this.dbService);
        this.sourceAttributionManager = new SourceAttributionManager(this.dbService);
        this.correctionLogManager = new CorrectionLogManager(this.dbService);
        this.successMetricsManager = new SuccessMetricsManager(this.dbService);
        this.planTaskManager = new PlanTaskManager(this.dbService);
        this.knowledgeGraphManager = new KnowledgeGraphManager(this.dbService);

        // Initialize GeminiIntegrationService with DatabaseService and ContextInformationManager
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        const genAIInstance = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : undefined;
        this.geminiIntegrationService = new GeminiIntegrationService(this.dbService, this.contextInformationManager, genAIInstance);

        this.databaseUtilityService = new DatabaseUtilityService(this.dbService);
    }

    // --- Conversation History (Delegated) ---
    async storeConversationMessage(...args: Parameters<ConversationHistoryManager['storeConversationMessage']>) {
        return this.conversationHistoryManager.storeConversationMessage(...args);
    }

    async getConversationHistory(...args: Parameters<ConversationHistoryManager['getConversationHistory']>) {
        return this.conversationHistoryManager.getConversationHistory(...args);
    }

    // --- Context Information (Delegated) ---
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

    // --- Reference Keys (Delegated) ---
    async addReferenceKey(...args: Parameters<ReferenceKeyManager['addReferenceKey']>) {
        return this.referenceKeyManager.addReferenceKey(...args);
    }

    async getReferenceKeys(...args: Parameters<ReferenceKeyManager['getReferenceKeys']>) {
        return this.referenceKeyManager.getReferenceKeys(...args);
    }

    // --- Source Attribution (Delegated) ---
    async logSourceAttribution(...args: Parameters<SourceAttributionManager['logSourceAttribution']>) {
        return this.sourceAttributionManager.logSourceAttribution(...args);
    }

    async getSourceAttributions(...args: Parameters<SourceAttributionManager['getSourceAttributions']>) {
        return this.sourceAttributionManager.getSourceAttributions(...args);
    }

    // --- Correction Logs (Delegated) ---
    async logCorrection(...args: Parameters<CorrectionLogManager['logCorrection']>) {
        return this.correctionLogManager.logCorrection(...args);
    }

    async getCorrectionLogs(...args: Parameters<CorrectionLogManager['getCorrectionLogs']>) {
        return this.correctionLogManager.getCorrectionLogs(...args);
    }

    // --- Success Metrics (Delegated) ---
    async logSuccessMetric(...args: Parameters<SuccessMetricsManager['logSuccessMetric']>) {
        return this.successMetricsManager.logSuccessMetric(...args);
    }

    async getSuccessMetrics(...args: Parameters<SuccessMetricsManager['getSuccessMetrics']>) {
        return this.successMetricsManager.getSuccessMetrics(...args);
    }

    // --- Plan and Task Management (Delegated) ---
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

    async updateTaskStatus(...args: Parameters<PlanTaskManager['updateTaskStatus']>) {
        return this.planTaskManager.updateTaskStatus(...args);
    }

    async deletePlan(...args: Parameters<PlanTaskManager['deletePlan']>) {
        return this.planTaskManager.deletePlan(...args);
    }

    async getTask(...args: Parameters<PlanTaskManager['getTask']>) {
        return this.planTaskManager.getTask(...args);
    }

    async addTaskToPlan(...args: Parameters<PlanTaskManager['addTaskToPlan']>) {
        return this.planTaskManager.addTaskToPlan(...args);
    }

    // --- Knowledge Graph Memory Tools (Delegated) ---
    async createEntities(...args: Parameters<KnowledgeGraphManager['createEntities']>) {
        return this.knowledgeGraphManager.createEntities(...args);
    }

    async createRelations(...args: Parameters<KnowledgeGraphManager['createRelations']>) {
        return this.knowledgeGraphManager.createRelations(...args);
    }

    async addObservations(...args: Parameters<KnowledgeGraphManager['addObservations']>) {
        return this.knowledgeGraphManager.addObservations(...args);
    }

    async deleteEntities(...args: Parameters<KnowledgeGraphManager['deleteEntities']>) {
        return this.knowledgeGraphManager.deleteEntities(...args);
    }

    async deleteObservations(...args: Parameters<KnowledgeGraphManager['deleteObservations']>) {
        return this.knowledgeGraphManager.deleteObservations(...args);
    }

    async deleteRelations(...args: Parameters<KnowledgeGraphManager['deleteRelations']>) {
        return this.knowledgeGraphManager.deleteRelations(...args);
    }

    async readGraph(...args: Parameters<KnowledgeGraphManager['readGraph']>) {
        return this.knowledgeGraphManager.readGraph(...args);
    }

    async searchNodes(...args: Parameters<KnowledgeGraphManager['searchNodes']>) {
        return this.knowledgeGraphManager.searchNodes(...args);
    }

    async openNodes(...args: Parameters<KnowledgeGraphManager['openNodes']>) {
        return this.knowledgeGraphManager.openNodes(...args);
    }

    // --- Gemini Integration (Delegated) ---
    async summarizeContext(...args: Parameters<GeminiIntegrationService['summarizeContext']>) {
        return this.geminiIntegrationService.summarizeContext(...args);
    }

    async extractEntities(...args: Parameters<GeminiIntegrationService['extractEntities']>) {
        return this.geminiIntegrationService.extractEntities(...args);
    }

    async semanticSearchContext(...args: Parameters<GeminiIntegrationService['semanticSearchContext']>) {
        return this.geminiIntegrationService.semanticSearchContext(...args);
    }

    async processAndRefinePrompt(...args: Parameters<GeminiIntegrationService['processAndRefinePrompt']>) {
        return this.geminiIntegrationService.processAndRefinePrompt(...args);
    }

    async storeRefinedPrompt(...args: Parameters<GeminiIntegrationService['storeRefinedPrompt']>) {
        return this.geminiIntegrationService.storeRefinedPrompt(...args);
    }

    async getRefinedPrompt(...args: Parameters<GeminiIntegrationService['getRefinedPrompt']>) {
        return this.geminiIntegrationService.getRefinedPrompt(...args);
    }

    // --- Database Utility (Delegated) ---
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
