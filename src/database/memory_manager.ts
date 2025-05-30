// src/database/memory_manager.ts
import { GoogleGenAI } from '@google/genai';
import { DatabaseService } from './services/DatabaseService.js';
import { ConversationHistoryManager } from './managers/ConversationHistoryManager.js';
import { ContextInformationManager } from './managers/ContextInformationManager.js';
import { ReferenceKeyManager } from './managers/ReferenceKeyManager.js';
import { SourceAttributionManager } from './managers/SourceAttributionManager.js';
import { CorrectionLogManager } from './managers/CorrectionLogManager.js';
import { SuccessMetricsManager } from './managers/SuccessMetricsManager.js';
import { PlanTaskManager } from './managers/PlanTaskManager.js';
import { SubtaskManager } from './managers/SubtaskManager.js';
import { KnowledgeGraphManager } from './managers/KnowledgeGraphManager.js';
import { ModeInstructionManager } from './managers/ModeInstructionManager.js';
import { ToolExecutionLogManager } from './managers/ToolExecutionLogManager.js';
import { TaskProgressLogManager } from './managers/TaskProgressLogManager.js';
import { ErrorLogManager } from './managers/ErrorLogManager.js';
import { GeminiIntegrationService } from './services/GeminiIntegrationService.js';
import { GeminiPlannerService } from './services/GeminiPlannerService.js';
import { DatabaseUtilityService } from './services/DatabaseUtilityService.js';
import { TaskReviewLogManager, FinalPlanReviewLogManager } from './managers/TaskReviewLogManager.js';
import { CodebaseEmbeddingService } from './services/CodebaseEmbeddingService.js';
import { CodebaseContextRetrieverService } from './services/CodebaseContextRetrieverService.js'; // Import new service
import { initializeVectorStoreDatabase, getVectorStoreDb, closeVectorStoreDatabase } from './vector_db.js';
import { Database } from 'sqlite';

export class MemoryManager {
    private dbService!: DatabaseService;
    private vectorDb!: Database;
    public conversationHistoryManager!: ConversationHistoryManager;
    public contextInformationManager!: ContextInformationManager;
    public referenceKeyManager!: ReferenceKeyManager;
    public sourceAttributionManager!: SourceAttributionManager;
    public correctionLogManager!: CorrectionLogManager;
    public successMetricsManager!: SuccessMetricsManager;
    public planTaskManager!: PlanTaskManager;
    public subtaskManager!: SubtaskManager;
    public knowledgeGraphManager!: KnowledgeGraphManager;
    public modeInstructionManager!: ModeInstructionManager;
    public toolExecutionLogManager!: ToolExecutionLogManager;
    public taskProgressLogManager!: TaskProgressLogManager;
    public errorLogManager!: ErrorLogManager;
    public geminiIntegrationService!: GeminiIntegrationService;
    public geminiPlannerService!: GeminiPlannerService;
    public codebaseEmbeddingService!: CodebaseEmbeddingService;
    public codebaseContextRetrieverService!: CodebaseContextRetrieverService; 
    private databaseUtilityService!: DatabaseUtilityService;
    public taskReviewLogManager!: TaskReviewLogManager;
    public finalPlanReviewLogManager!: FinalPlanReviewLogManager;

    public projectRootPath: string = process.cwd();

    private constructor() {
        // Private constructor to enforce async factory
    }

    public getDbService(): DatabaseService {
        return this.dbService;
    }

    public getVectorDb(): Database {
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
        this.referenceKeyManager = new ReferenceKeyManager(this.dbService);
        this.sourceAttributionManager = new SourceAttributionManager(this.dbService);
        this.correctionLogManager = new CorrectionLogManager(this.dbService);
        this.successMetricsManager = new SuccessMetricsManager(this.dbService);
        this.planTaskManager = new PlanTaskManager(this.dbService);
        this.subtaskManager = new SubtaskManager(this.dbService);
        this.knowledgeGraphManager = new KnowledgeGraphManager(this.dbService, null as any); // Temporarily null
        this.modeInstructionManager = new ModeInstructionManager(this.dbService);
        this.toolExecutionLogManager = new ToolExecutionLogManager(this.dbService);
        this.taskProgressLogManager = new TaskProgressLogManager(this.dbService);
        this.errorLogManager = new ErrorLogManager(this.dbService);
        this.taskReviewLogManager = new TaskReviewLogManager(this.dbService);
        this.finalPlanReviewLogManager = new FinalPlanReviewLogManager(this.dbService);
        this.databaseUtilityService = new DatabaseUtilityService(this.dbService);

        // Now create GeminiIntegrationService
        this.geminiIntegrationService = new GeminiIntegrationService(
            this.dbService, 
            this.contextInformationManager, 
            this, 
            genAIInstance
        );
        
        // Update managers that need GeminiIntegrationService
        this.conversationHistoryManager = new ConversationHistoryManager(this.dbService, this.geminiIntegrationService);
        this.knowledgeGraphManager = new KnowledgeGraphManager(this.dbService, this.geminiIntegrationService);
        
        // Create GeminiPlannerService
        this.geminiPlannerService = new GeminiPlannerService(this.geminiIntegrationService, this);
        
        // Create CodebaseEmbeddingService after GeminiIntegrationService is ready
        this.codebaseEmbeddingService = new CodebaseEmbeddingService(this, this.vectorDb);
        
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

    // --- Tool Execution Logs ---
    async createToolExecutionLog(...args: Parameters<ToolExecutionLogManager['createToolExecutionLog']>) {
        return this.toolExecutionLogManager.createToolExecutionLog(...args);
    }
    async getToolExecutionLogById(...args: Parameters<ToolExecutionLogManager['getToolExecutionLogById']>) {
        return this.toolExecutionLogManager.getToolExecutionLogById(...args);
    }
    async getToolExecutionLogsByAgentId(...args: Parameters<ToolExecutionLogManager['getToolExecutionLogsByAgentId']>) {
        return this.toolExecutionLogManager.getToolExecutionLogsByAgentId(...args);
    }
    async updateToolExecutionLogStatus(...args: Parameters<ToolExecutionLogManager['updateToolExecutionLogStatus']>) {
        return this.toolExecutionLogManager.updateToolExecutionLogStatus(...args);
    }
    async deleteToolExecutionLog(...args: Parameters<ToolExecutionLogManager['deleteToolExecutionLog']>) {
        return this.toolExecutionLogManager.deleteToolExecutionLog(...args);
    }

    // --- Task Progress Logs ---
    async createTaskProgressLog(...args: Parameters<TaskProgressLogManager['createTaskProgressLog']>) {
        return this.taskProgressLogManager.createTaskProgressLog(...args);
    }
    async getTaskProgressLogById(...args: Parameters<TaskProgressLogManager['getTaskProgressLogById']>) {
        return this.taskProgressLogManager.getTaskProgressLogById(...args);
    }
    async getTaskProgressLogsByAgentId(...args: Parameters<TaskProgressLogManager['getTaskProgressLogsByAgentId']>) {
        return this.taskProgressLogManager.getTaskProgressLogsByAgentId(...args);
    }
    async updateTaskProgressLogStatus(...args: Parameters<TaskProgressLogManager['updateTaskProgressLogStatus']>) {
        return this.taskProgressLogManager.updateTaskProgressLogStatus(...args);
    }
    async deleteTaskProgressLog(...args: Parameters<TaskProgressLogManager['deleteTaskProgressLog']>) {
        return this.taskProgressLogManager.deleteTaskProgressLog(...args);
    }

    // --- Error Logs ---
    async createErrorLog(...args: Parameters<ErrorLogManager['createErrorLog']>) {
        return this.errorLogManager.createErrorLog(...args);
    }
    async getErrorLogById(...args: Parameters<ErrorLogManager['getErrorLogById']>) {
        return this.errorLogManager.getErrorLogById(...args);
    }
    async getErrorLogsByAgentId(...args: Parameters<ErrorLogManager['getErrorLogsByAgentId']>) {
        return this.errorLogManager.getErrorLogsByAgentId(...args);
    }
    async updateErrorLogStatus(...args: Parameters<ErrorLogManager['updateErrorLogStatus']>) {
        return this.errorLogManager.updateErrorLogStatus(...args);
    }
    async deleteErrorLog(...args: Parameters<ErrorLogManager['deleteErrorLog']>) {
        return this.errorLogManager.deleteErrorLog(...args);
    }

    // --- Conversation History ---
    async storeConversationMessage(...args: Parameters<ConversationHistoryManager['storeConversationMessage']>) {
        return this.conversationHistoryManager.storeConversationMessage(...args);
    }
    async getConversationHistory(...args: Parameters<ConversationHistoryManager['getConversationHistory']>) {
        return this.conversationHistoryManager.getConversationHistory(...args);
    }
    async searchConversationByKeywords(...args: Parameters<ConversationHistoryManager['searchConversationByKeywords']>) {
        return this.conversationHistoryManager.searchConversationByKeywords(...args);
    }
    async summarizeConversation(...args: Parameters<ConversationHistoryManager['summarizeConversation']>) {
        return this.conversationHistoryManager.summarizeConversation(...args);
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

    // --- Source Attribution ---
    async logSourceAttribution(...args: Parameters<SourceAttributionManager['logSourceAttribution']>) {
        return this.sourceAttributionManager.logSourceAttribution(...args);
    }
    async getSourceAttributions(...args: Parameters<SourceAttributionManager['getSourceAttributions']>) {
        return this.sourceAttributionManager.getSourceAttributions(...args);
    }

    // --- Correction Logs ---
    async logCorrection(...args: Parameters<CorrectionLogManager['logCorrection']>) {
        return this.correctionLogManager.logCorrection(...args);
    }
    async getCorrectionLogs(...args: Parameters<CorrectionLogManager['getCorrectionLogs']>) {
        return this.correctionLogManager.getCorrectionLogs(...args);
    }
    async updateCorrectionLogStatus(...args: Parameters<CorrectionLogManager['updateCorrectionLogStatus']>) {
        return this.correctionLogManager.updateCorrectionLogStatus(...args);
    }

    // --- Success Metrics ---
    async logSuccessMetric(...args: Parameters<SuccessMetricsManager['logSuccessMetric']>) {
        return this.successMetricsManager.logSuccessMetric(...args);
    }
    async getSuccessMetrics(...args: Parameters<SuccessMetricsManager['getSuccessMetrics']>) {
        return this.successMetricsManager.getSuccessMetrics(...args);
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

    // --- Knowledge Graph ---
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
    async queryNaturalLanguage(...args: Parameters<KnowledgeGraphManager['queryNaturalLanguage']>) {
        return this.knowledgeGraphManager.queryNaturalLanguage(...args);
    }
    async inferRelations(...args: Parameters<KnowledgeGraphManager['inferRelations']>) {
        return this.knowledgeGraphManager.inferRelations(...args);
    }
     async generateMermaidGraph(...args: Parameters<KnowledgeGraphManager['generateMermaidGraph']>) {
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
    async processAndRefinePrompt(...args: Parameters<GeminiIntegrationService['processAndRefinePrompt']>) {
        return this.geminiIntegrationService.processAndRefinePrompt(...args);
    }
    async storeRefinedPrompt(...args: Parameters<GeminiIntegrationService['storeRefinedPrompt']>) {
        return this.geminiIntegrationService.storeRefinedPrompt(...args);
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

    // --- Task Review Logs ---
    async createTaskReviewLog(data: any) { return this.taskReviewLogManager.createTaskReviewLog(data); }
    async getTaskReviewLogs(query: any) { return this.taskReviewLogManager.getTaskReviewLogs(query); }
    async updateTaskReviewLog(review_log_id: string, updates: any) { return this.taskReviewLogManager.updateTaskReviewLog(review_log_id, updates); }
    async deleteTaskReviewLog(review_log_id: string) { return this.taskReviewLogManager.deleteTaskReviewLog(review_log_id); }

    // --- Final Plan Review Logs ---
    async createFinalPlanReviewLog(data: any) { return this.finalPlanReviewLogManager.createFinalPlanReviewLog(data); }
    async getFinalPlanReviewLogs(query: any) { return this.finalPlanReviewLogManager.getFinalPlanReviewLogs(query); }
    async updateFinalPlanReviewLog(final_review_log_id: string, updates: any) { return this.finalPlanReviewLogManager.updateFinalPlanReviewLog(final_review_log_id, updates); }
    async deleteFinalPlanReviewLog(final_review_log_id: string) { return this.finalPlanReviewLogManager.deleteFinalPlanReviewLog(final_review_log_id); }
}
