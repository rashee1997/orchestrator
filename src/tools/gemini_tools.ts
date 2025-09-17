import { MemoryManager } from '../database/memory_manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { InternalToolDefinition } from './index.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatPlanGenerationResponseToMarkdown } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { RAG_DECISION_PROMPT, CODE_REVIEW_META_PROMPT, CODE_EXPLANATION_META_PROMPT, ENHANCEMENT_SUGGESTIONS_META_PROMPT, BUG_FIXING_META_PROMPT, REFACTORING_META_PROMPT, TESTING_META_PROMPT, DOCUMENTATION_META_PROMPT, DEFAULT_CODEBASE_ASSISTANT_META_PROMPT, CODE_MODULARIZATION_ORCHESTATION_META_PROMPT, GENERAL_WEB_ASSISTANT_META_PROMPT, GEMINI_GOOGLE_SEARCH_PROMPT, INTENT_CLASSIFICATION_PROMPT, CONVERSATIONAL_CODEBASE_ASSISTANT_META_PROMPT, RAG_VERIFICATION_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { RetrievedCodeContext } from '../database/services/CodebaseContextRetrieverService.js';
import { formatRetrievedContextForPrompt } from '../database/services/gemini-integration-modules/GeminiContextFormatter.js';
import { parseGeminiJsonResponse, parseGeminiJsonResponseSync } from '../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { REFINEMENT_MODEL_NAME, DEFAULT_ASK_MODEL_NAME, getCurrentModel } from '../database/services/gemini-integration-modules/GeminiConfig.js';
import { META_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { ContextRetrievalOptions } from '../database/services/CodebaseContextRetrieverService.js';
import { IterativeRagOrchestrator, IterativeRagResult, IterativeRagArgs } from './rag/iterative_rag_orchestrator.js';
import { randomUUID } from 'crypto';
import { ConversationMessage, ConversationSession } from '../database/managers/ConversationHistoryManager.js';
import { callTavilyApi, WebSearchResult } from '../integrations/tavily.js';

const VALID_FOCUS_AREAS = [
    "code_review", "code_explanation", "enhancement_suggestions", "bug_fixing",
    "refactoring", "testing", "documentation", "code_modularization_orchestration", "codebase_analysis"
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function findProjectRoot(startDir: string): Promise<string> {
    let currentDir = startDir;
    while (true) {
        const packageJsonPath = path.join(currentDir, 'package.json');
        try {
            await fs.access(packageJsonPath);
            return currentDir;
        } catch (error) {
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) {
                console.warn('[ask_gemini] Could not find package.json to determine project root. Falling back to current working directory.');
                return process.cwd();
            }
            currentDir = parentDir;
        }
    }
}

async function _getIntentFocusArea(query: string, geminiService: GeminiIntegrationService): Promise<string | null> {
    try {
        const classificationPrompt = INTENT_CLASSIFICATION_PROMPT.replace('{query}', query);
        const result = await geminiService.askGemini(classificationPrompt, getCurrentModel());
        const rawResponse = result.content[0].text || '';

        // Clean and normalize the response
        let intent = rawResponse
            .trim()
            .toLowerCase()
            .replace(/[`*]/g, '') // Remove markdown formatting
            .replace(/^-+\s*/g, '') // Remove leading dashes
            .replace(/\s*-\s*$/g, '') // Remove trailing dashes
            .replace(/^\s*["']|["']\s*$/g, '') // Remove surrounding quotes
            .trim();

        console.log(`[ask_gemini] Raw Gemini response: "${rawResponse}"`);
        console.log(`[ask_gemini] Processed intent: "${intent}"`);

        // Check if the processed intent is valid
        if (VALID_FOCUS_AREAS.includes(intent)) {
            console.log(`[ask_gemini] Valid focus area selected: "${intent}"`);
            return intent;
        }

        // Try partial matching for common variations
        const partialMatch = VALID_FOCUS_AREAS.find(area =>
            intent.includes(area.replace(/_/g, ' ')) ||
            area.includes(intent.replace(/\s+/g, '_'))
        );

        if (partialMatch) {
            console.log(`[ask_gemini] Partial match found, using: "${partialMatch}"`);
            return partialMatch;
        }

        console.warn(`[ask_gemini] Intent classification returned an invalid focus area: "${intent}". Valid areas: ${VALID_FOCUS_AREAS.join(', ')}`);

        // Fallback to a reasonable default based on query content
        const fallbackIntent = _getFallbackIntent(query);
        console.log(`[ask_gemini] Using fallback intent: "${fallbackIntent}"`);
        return fallbackIntent;

    } catch (error: any) {
        console.error(`[ask_gemini] Error during AI-powered intent classification:`, error);

        // Even on error, try to provide a reasonable fallback
        const fallbackIntent = _getFallbackIntent(query);
        console.log(`[ask_gemini] Using fallback intent after error: "${fallbackIntent}"`);
        return fallbackIntent;
    }
}

// Helper function to determine a reasonable fallback intent based on query content
function _getFallbackIntent(query: string): string {
    const lowerQuery = query.toLowerCase();

    // Explanatory queries - highest priority
    if (lowerQuery.includes('how') || lowerQuery.includes('explain') || lowerQuery.includes('what is') ||
        lowerQuery.includes('describe') || lowerQuery.includes('tell me about')) {
        return 'code_explanation';
    }

    // Code review related keywords
    if (lowerQuery.includes('review') || lowerQuery.includes('bug') || lowerQuery.includes('error') ||
        lowerQuery.includes('fix') || lowerQuery.includes('issue')) {
        return 'code_review';
    }

    // Enhancement related keywords
    if (lowerQuery.includes('improve') || lowerQuery.includes('enhance') || lowerQuery.includes('optimize') ||
        lowerQuery.includes('better') || lowerQuery.includes('performance')) {
        return 'enhancement_suggestions';
    }

    // Documentation related keywords
    if (lowerQuery.includes('doc') || lowerQuery.includes('comment') || lowerQuery.includes('readme')) {
        return 'documentation';
    }

    // Testing related keywords
    if (lowerQuery.includes('test') || lowerQuery.includes('spec')) {
        return 'testing';
    }

    // Refactoring related keywords
    if (lowerQuery.includes('refactor') || lowerQuery.includes('clean') || lowerQuery.includes('structure')) {
        return 'refactoring';
    }

    // Default fallback for general queries
    return 'codebase_analysis';
}

async function _performIterativeRagSearch(args: IterativeRagArgs, memoryManagerInstance: MemoryManager, geminiService: GeminiIntegrationService): Promise<IterativeRagResult> {
    const diverseQueryRewriterService = new (await import('./rag/diverse_query_rewriter_service.js')).DiverseQueryRewriterService(geminiService, memoryManagerInstance);
    const orchestrator = new IterativeRagOrchestrator(memoryManagerInstance, geminiService, diverseQueryRewriterService);
    return await orchestrator.performIterativeSearch(args);
}

export const askGeminiToolDefinition: InternalToolDefinition = {
    name: 'ask_gemini',
    description: 'Asks a query to the Gemini AI. Manages conversation history in the central database.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'The agent ID to use for context retrieval.' },
            query: { type: 'string', description: 'The query string to send to Gemini.' },
            session_id: { type: ['string', 'null'], description: 'The UUID of a past conversation to continue. Use this with `continue: true`.', nullable: true },
            session_name: { type: ['string', 'null'], description: 'Optional: A human-readable name for the session to continue or create. If provided with `continue: true`, it will try to find a session by this name.', nullable: true },
            session_sequence_number: { type: ['number', 'null'], description: 'Optional: A sequence number for the session to continue or create. If provided with `continue: true`, it will try to find a session by this sequence number among your created sessions.', nullable: true },
            continue: {
                type: 'boolean',
                description: 'If true, continues a conversation. If `session_id` is provided, it continues that specific session. If not, it tries to find the most recent session, or a session by `session_name` or `session_sequence_number`. If false, it starts a new session.',
                default: false,
                nullable: true
            },
            conversation_history_limit: { type: 'number', description: 'The number of recent messages to include from the session history.', default: 15 },
            model: { type: 'string', description: 'Optional: The Gemini model to use.', default: getCurrentModel() },
            systemInstruction: { type: 'string', description: 'Optional: A system instruction to guide the AI behavior.', nullable: true },
            enable_rag: { type: 'boolean', description: 'Enable Retrieval-Augmented Generation (RAG).', default: false, nullable: true },
            enable_iterative_search: {
                type: 'boolean',
                description: 'Manually enable iterative search for a *new* query. When continuing a conversation, the AI will autonomously decide whether to trigger this powerful search mode if it needs more information.',
                default: false
            },
            enable_web_search: { type: 'boolean', description: 'Allow autonomous web searches during iterative RAG.', default: false },
            max_iterations: {
                type: 'number',
                description: 'Max iterations for iterative search. If DMQR is enabled, this is the number of iterations *per* generated query.',
                default: 5,
                minimum: 1,
                maximum: 8
            },
            enable_dmqr: {
                type: 'boolean',
                description: 'Enable Diverse Multi-Query Rewriting (DMQR) for enhanced RAG context. When enabled, automatically generates diverse queries for both embeddings-based retrieval and knowledge graph queries for comprehensive context gathering.',
                default: false
            },
            dmqr_query_count: {
                type: 'number',
                description: 'The number of diverse embedding queries to generate for DMQR. Knowledge graph queries are automatically generated (typically half this number) when DMQR is enabled.',
                default: 3,
                minimum: 2,
                maximum: 5
            },
            live_review_file_paths: { type: 'array', items: { type: 'string' }, description: 'Array of full file paths for live chunking and review.', nullable: true },
            focus_area: { type: 'string', description: 'Manually set a focus area to override autonomous selection.', enum: VALID_FOCUS_AREAS, nullable: true },
            analysis_focus_points: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: [
                        "Potential Bugs & Errors", "Best Practices & Conventions", "Performance",
                        "Security Vulnerabilities", "Readability & Maintainability", "Duplications",
                        "Code Smells", "Testability", "Error Handling", "Modularity & Coupling",
                        "Documentation & Comments"
                    ]
                },
                description: 'Specific aspects to focus on during a review.',
                nullable: true
            },
            context_options: {
                type: 'object',
                properties: {
                    topKEmbeddings: { type: 'number', nullable: true },
                    kgQueryDepth: { type: 'number', nullable: true },
                    includeFileContent: { type: 'boolean', nullable: true },
                    targetFilePaths: { type: 'array', items: { type: 'string' }, nullable: true },
                    topKKgResults: { type: 'number', nullable: true },
                    embeddingScoreThreshold: { type: 'number', nullable: true },
                    useHybridSearch: { type: 'boolean', nullable: true, description: 'Enable hybrid search combining vector and keyword search' },
                    // enableKeywordSearch: { type: 'boolean', nullable: true, description: 'Enable enhanced keyword search within hybrid search' }, // COMMENTED OUT
                    // keywordWeight: { type: 'number', nullable: true, description: 'Weight for keyword search results (0.0-1.0)', minimum: 0, maximum: 1 }, // COMMENTED OUT
                    // taskType: { // COMMENTED OUT
                    //     type: 'string',
                    //     nullable: true,
                    //     enum: ['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT', 'CODE_RETRIEVAL_QUERY', 'SEMANTIC_SIMILARITY', 'CLASSIFICATION'],
                    //     description: 'Gemini task type for optimized search behavior'
                    // },
                    // enableBatchProcessing: { type: 'boolean', nullable: true, description: 'Enable batch processing of contexts (3 files at a time)' }, // COMMENTED OUT
                    enableReranking: { type: 'boolean', nullable: true, description: 'Enable AI-powered context reranking' },
                    maxContextLength: { type: 'number', nullable: true, description: 'Maximum context length for processing' }
                },
                additionalProperties: false,
                nullable: true
            },
            execution_mode: {
                type: 'string',
                description: 'Specifies the desired output format.',
                enum: ['generative_answer', 'plan_generation'],
                default: 'generative_answer',
                nullable: true
            },
            target_ai_persona: { type: 'string', description: 'Optional: The AI persona to target for the response.', nullable: true },
            conversation_context_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: IDs of previous conversations to include as context.', nullable: true },
            hallucination_check_threshold: { type: 'number', description: 'Optional: Threshold for hallucination detection (0-1).', nullable: true },
            google_search: { type: 'boolean', description: 'Optional: If true, enables Gemini\'s built-in Google Search grounding for the query.', default: false, nullable: true },
            enable_hybrid_search: { type: 'boolean', description: 'Enable advanced hybrid search combining vector, keyword, and KG search', default: false, nullable: true },
            enable_agentic_planning: { type: 'boolean', description: 'Enable AI-driven search planning and strategy selection', default: false, nullable: true },
            enable_reflection: { type: 'boolean', description: 'Enable reflection-based quality control and self-correction', default: true, nullable: true },
            enable_long_rag: { type: 'boolean', description: 'Enable Long RAG for processing large contexts', default: true, nullable: true },
            enable_corrective_rag: { type: 'boolean', description: 'Enable corrective RAG for iterative improvement', default: true, nullable: true },
            reflection_frequency: { type: 'number', description: 'Frequency of reflection checks (every N iterations)', default: 2, minimum: 1, maximum: 5, nullable: true },
            long_rag_chunk_size: { type: 'number', description: 'Chunk size for Long RAG processing', default: 2000, minimum: 500, maximum: 5000, nullable: true },
            citation_accuracy_threshold: { type: 'number', description: 'Minimum accuracy threshold for citations (0.0-1.0)', default: 0.6, minimum: 0, maximum: 1, nullable: true },
        },
        required: ['agent_id', 'query']
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) {
            throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required for ask_gemini");
        }

        const {
            agent_id, query, model, systemInstruction, enable_rag, analysis_focus_points,
            context_options, live_review_file_paths, enable_iterative_search, execution_mode,
            target_ai_persona, conversation_context_ids, enable_web_search, max_iterations,
            hallucination_check_threshold,
            google_search,
            enable_dmqr,
            dmqr_query_count,
            session_id, session_name, session_sequence_number, conversation_history_limit,
            continue: continue_session,
            // Enhanced RAG parameters
            enable_hybrid_search,
            enable_agentic_planning,
            enable_reflection,
            enable_long_rag,
            enable_corrective_rag,
            reflection_frequency,
            long_rag_chunk_size,
            citation_accuracy_threshold
        } = args;

        // Validate and sanitize count parameters to prevent negative values
        const sanitized_dmqr_query_count = Math.max(2, Math.min(5, dmqr_query_count || 3));
        const sanitized_max_iterations = Math.max(1, Math.min(8, max_iterations || 5));
        const sanitized_conversation_history_limit = Math.max(1, conversation_history_limit || 15);
        const sanitized_reflection_frequency = Math.max(1, Math.min(5, reflection_frequency || 2));
        const sanitized_long_rag_chunk_size = Math.max(500, Math.min(5000, long_rag_chunk_size || 2000));
        const sanitized_citation_accuracy_threshold = Math.max(0, Math.min(1, citation_accuracy_threshold || 0.6));

        console.log(`[ask_gemini] Parameter sanitization: dmqr_query_count=${dmqr_query_count} -> ${sanitized_dmqr_query_count}, max_iterations=${max_iterations} -> ${sanitized_max_iterations}`);

        // Override the original parameters with sanitized values
        const sanitized_args = {
            ...args,
            dmqr_query_count: sanitized_dmqr_query_count,
            max_iterations: sanitized_max_iterations,
            conversation_history_limit: sanitized_conversation_history_limit,
            reflection_frequency: sanitized_reflection_frequency,
            long_rag_chunk_size: sanitized_long_rag_chunk_size,
            citation_accuracy_threshold: sanitized_citation_accuracy_threshold
        };

        let focus_area = sanitized_args.focus_area; // Make focus_area mutable

        const userExplicitlyEnabledRag = enable_rag;
        const userExplicitlyEnabledIterativeSearch = enable_iterative_search;

        let mutable_live_review_paths = live_review_file_paths ? [...live_review_file_paths] : [];
        let mutable_enable_rag = enable_rag;
        let mutable_enable_iterative_search = enable_iterative_search;

        const geminiService = memoryManagerInstance.getGeminiIntegrationService();
        const conversationHistoryManager = memoryManagerInstance.conversationHistoryManager;

        // Autonomous focus area selection
        let autonomousFocusArea: string | null = null;
        let autonomousFocusDecision: { selected: string | null; reasoning: string } = { selected: null, reasoning: 'User explicitly provided focus area' };

        if (!focus_area) {
            try {
                console.log('[ask_gemini] No focus area provided. Attempting autonomous selection...');
                autonomousFocusArea = await _getIntentFocusArea(query, geminiService);
                if (autonomousFocusArea) {
                    autonomousFocusDecision = {
                        selected: autonomousFocusArea,
                        reasoning: `Autonomously selected focus area '${autonomousFocusArea}' based on query intent classification`
                    };
                    console.log(`[ask_gemini] Autonomous focus area selection: ${autonomousFocusArea}`);
                    // Use the autonomously selected focus area
                    focus_area = autonomousFocusArea;
                } else {
                    autonomousFocusDecision = {
                        selected: null,
                        reasoning: 'Autonomous selection failed or returned invalid focus area'
                    };
                    console.log('[ask_gemini] Autonomous focus area selection failed. Using default behavior.');
                }
            } catch (error: any) {
                autonomousFocusDecision = {
                    selected: null,
                    reasoning: `Error during autonomous selection: ${error?.message || 'Unknown error'}`
                };
                console.error('[ask_gemini] Error during autonomous focus area selection:', error);
            }
        }

        let currentSessionId: string | null = session_id;

        if (continue_session) {
            if (!currentSessionId) {
                let sessions: ConversationSession[] = [];
                if (session_name) {
                    sessions = await conversationHistoryManager.getConversationSessionsByTitle(agent_id, session_name);
                    if (sessions.length > 0) {
                        currentSessionId = sessions[0].session_id;
                        console.log(`[ask_gemini] Continuing session by name: "${session_name}" (ID: ${currentSessionId})`);
                    } else {
                        throw new McpError(ErrorCode.InvalidParams, `No session found with title: "${session_name}" for agent: ${agent_id}`);
                    }
                } else if (session_sequence_number !== null && session_sequence_number !== undefined) {
                    sessions = await conversationHistoryManager.getConversationSessionsBySequence(agent_id, session_sequence_number);
                    if (sessions.length > 0) {
                        currentSessionId = sessions[0].session_id;
                        console.log(`[ask_gemini] Continuing session by sequence number: ${session_sequence_number} (ID: ${currentSessionId})`);
                    } else {
                        throw new McpError(ErrorCode.InvalidParams, `No session found with sequence number: ${session_sequence_number} for agent: ${agent_id}`);
                    }
                } else {
                    sessions = await conversationHistoryManager.getConversationSessions(agent_id, null, 1);
                    if (sessions.length > 0) {
                        currentSessionId = sessions[0].session_id;
                        console.log(`[ask_gemini] Continuing most recent session ID: ${currentSessionId}`);
                    }
                }
            }
        }

        if (!currentSessionId) {
            const conversationTitle = await geminiService.generateConversationTitle(query);
            currentSessionId = await conversationHistoryManager.createConversationSession(agent_id, conversationTitle);
            console.log(`[ask_gemini] Starting new session: ${currentSessionId} with title: "${conversationTitle}"`);
        }

        await conversationHistoryManager.storeConversationMessage(currentSessionId, 'user', query);

        const historyMessages = await conversationHistoryManager.getConversationMessages(currentSessionId, sanitized_conversation_history_limit);
        const hasConversationHistory = historyMessages.length > 1; // More than just the current user query
        let ragQuery = query;

        if (hasConversationHistory && !userExplicitlyEnabledRag && !userExplicitlyEnabledIterativeSearch) {
            try {
                console.log('[ask_gemini] Conversation history detected. Analyzing if RAG is needed...');

                const conversationHistoryForPrompt = historyMessages
                    .filter(m => m.message_type !== 'tool_call' && m.message_type !== 'tool_output') // Filter out tool messages for cleaner context
                    .map(m => `${m.sender}: ${m.message_content}`)
                    .join('\n');

                const decisionPrompt = RAG_DECISION_PROMPT
                    .replace('{conversation_history}', conversationHistoryForPrompt)
                    .replace('{new_query}', query)
                    .replace('{web_search_flags}', `google_search=${google_search || false}, enable_web_search=${enable_web_search || false}`)
                    .replace('{continuation_mode}', `continue=${continue_session || false}`);

                const decisionResult = await geminiService.askGemini(decisionPrompt, getCurrentModel());
                const decisionResponse = await parseGeminiJsonResponse(decisionResult.content[0].text ?? '', {
                    expectedStructure: '{"decision": "ANSWER_FROM_HISTORY or PERFORM_RAG", "reasoning": "string", "rag_query": "string or null"}',
                    contextDescription: 'RAG decision response for conversation continuation',
                    memoryManager: memoryManagerInstance,
                    geminiService: geminiService,
                    enableAIRepair: true
                });

                // Store the autonomous decision in tool_info for transparency
                const autonomousDecision = {
                    type: 'autonomous_rag_decision',
                    decision: decisionResponse.decision,
                    reasoning: decisionResponse.decision === 'ANSWER_FROM_HISTORY' ?
                        'Sufficient information found in conversation history' :
                        'New information needed - performing RAG search',
                    original_query: query,
                    refined_query: decisionResponse.rag_query || null,
                    confidence: 'high',
                    timestamp: new Date().toISOString()
                };

                // Store this decision in the conversation for transparency
                await conversationHistoryManager.storeConversationMessage(
                    currentSessionId,
                    'system',
                    `🤖 **Autonomous RAG Decision**: ${decisionResponse.decision}\n\n**Reasoning**: ${autonomousDecision.reasoning}`,
                    'thought',
                    {
                        autonomous_rag_decision: autonomousDecision,
                        conversation_context_used: conversationHistoryForPrompt.length > 0
                    }
                );

                if (decisionResponse.decision === 'ANSWER_FROM_HISTORY') {
                    console.log('[ask_gemini] ✅ AI Decision: Answer from history.');
                    if (google_search || enable_web_search) {
                        console.log('[ask_gemini] 🌐 Web search enabled - will augment history with web search.');
                        // Keep web search enabled but disable RAG
                        mutable_enable_rag = false;
                        mutable_enable_iterative_search = false;
                    } else {
                        console.log('[ask_gemini] 📜 Pure history response - skipping all external search.');
                        mutable_enable_rag = false;
                        mutable_enable_iterative_search = false;
                    }
                    mutable_live_review_paths = [];
                } else if (decisionResponse.decision === 'PERFORM_RAG' && decisionResponse.rag_query) {
                    console.log(`[ask_gemini] 🔍 AI Decision: Perform RAG with refined query: "${decisionResponse.rag_query}"`);
                    ragQuery = decisionResponse.rag_query;
                    console.log('[ask_gemini] Autonomously enabling iterative search for follow-up query.');
                    mutable_enable_iterative_search = true;
                }

                console.log(`[ask_gemini] 📊 Autonomous decision logged for transparency`);

            } catch (e: any) {
                console.warn('[ask_gemini] RAG decision pre-analysis failed. Proceeding with user settings.', e);

                // Log the failure for transparency
                await conversationHistoryManager.storeConversationMessage(
                    currentSessionId,
                    'system',
                    `⚠️ **Autonomous RAG Decision Failed**: ${e?.message || 'Unknown error'}\n\nProceeding with user settings.`,
                    'thought',
                    { error: e?.message || 'Unknown error', fallback_to_user_settings: true }
                );
            }
        } else if (continue_session && !hasConversationHistory) {
            // Log when continue was requested but no history was found
            await conversationHistoryManager.storeConversationMessage(
                currentSessionId,
                'system',
                `ℹ️ **Continue Session Requested**: No substantial conversation history found. Starting fresh.`,
                'thought',
                { continue_requested: true, history_found: false }
            );
        }

        let iterativeResult: IterativeRagResult | null = null;
        let finalContext: RetrievedCodeContext[] = [];

        console.log(`[ask_gemini] State before context acquisition: mutable_enable_iterative_search=${mutable_enable_iterative_search}, mutable_enable_rag=${mutable_enable_rag}`);

        try {
            if (mutable_enable_iterative_search) {
                console.log('[ask_gemini] Calling enhanced _performIterativeRagSearch...');
                
                // Enhanced context options with new features - SIMPLIFIED
                const enhancedContextOptions = {
                    ...context_options,
                    useHybridSearch: enable_hybrid_search || context_options?.useHybridSearch || false,
                    // enableKeywordSearch: context_options?.enableKeywordSearch ?? true, // COMMENTED OUT
                    // keywordWeight: context_options?.keywordWeight ?? 0.8, // COMMENTED OUT
                    // taskType: context_options?.taskType || 'CODE_RETRIEVAL_QUERY', // COMMENTED OUT
                    // enableBatchProcessing: context_options?.enableBatchProcessing ?? true, // COMMENTED OUT
                    enableReranking: context_options?.enableReranking ?? true
                };

                // Enhanced RAG arguments using sanitized parameters
                const enhancedRagArgs: IterativeRagArgs = {
                    ...sanitized_args,
                    query: ragQuery,
                    context_options: enhancedContextOptions,
                    enable_hybrid_search: enable_hybrid_search ?? true,
                    enable_agentic_planning: enable_agentic_planning ?? false,
                    enable_reflection: enable_reflection ?? true,
                    enable_long_rag: enable_long_rag ?? true,
                    enable_corrective_rag: enable_corrective_rag ?? true,
                    reflection_frequency: sanitized_reflection_frequency,
                    long_rag_chunk_size: sanitized_long_rag_chunk_size,
                    citation_accuracy_threshold: sanitized_citation_accuracy_threshold,
                    dmqr_query_count: sanitized_dmqr_query_count,
                    max_iterations: sanitized_max_iterations,
                    conversation_history_limit: sanitized_conversation_history_limit,
                    google_search: google_search,
                    continue_session: continue_session
                };

                console.log(`[ask_gemini] Enhanced RAG enabled: hybrid=${enhancedRagArgs.enable_hybrid_search}, agentic=${enhancedRagArgs.enable_agentic_planning}, reflection=${enhancedRagArgs.enable_reflection}`);
                console.log(`[ask_gemini] Context options: taskType=${enhancedContextOptions.taskType}, batchProcessing=${enhancedContextOptions.enableBatchProcessing}`);
                
                iterativeResult = await _performIterativeRagSearch(enhancedRagArgs, memoryManagerInstance, geminiService);
                finalContext = iterativeResult.accumulatedContext;
                console.log(`[ask_gemini] Enhanced _performIterativeRagSearch completed. SearchMetrics: ${JSON.stringify(iterativeResult.searchMetrics)}`);
            } else if (mutable_enable_rag || mutable_live_review_paths?.length) {
                console.log('[ask_gemini] Performing single-turn RAG...');
                const contextRetrieverService = memoryManagerInstance.getCodebaseContextRetrieverService();
                const contextOptionsWithLiveFiles = { ...context_options, targetFilePaths: [...(context_options?.targetFilePaths || []), ...mutable_live_review_paths] };
                finalContext = await contextRetrieverService.retrieveContextForPrompt(agent_id, ragQuery, contextOptionsWithLiveFiles);
            }
        } catch (error: any) {
            console.error('[ask_gemini] Error during context acquisition:', error);
            throw new McpError(ErrorCode.InternalError, `Context Acquisition failed: ${error.message}`);
        }

        console.log(`[ask_gemini] Context acquisition complete. Acquired ${finalContext.length} items. iterativeResult is ${iterativeResult ? 'populated' : 'null'}.`);

        if (execution_mode === 'plan_generation') {
            const modelToUse = model || REFINEMENT_MODEL_NAME;
            const contextString = formatRetrievedContextForPrompt(finalContext)[0]?.text || 'No relevant context was found.';
            const metaPromptContent = META_PROMPT
                .replace('{modelToUse}', modelToUse)
                .replace('{raw_user_prompt}', query)
                .replace('{retrievedCodeContextString}', contextString)
                .replace('{agentId}', agent_id);
            try {
                const result = await geminiService.askGemini(metaPromptContent, modelToUse);
                const parsedResponse = await parseGeminiJsonResponse(result.content[0].text ?? '', {
                    expectedStructure: '{"plan_title": "string", "tasks": [{"task_number": "number", "title": "string", "description": "string"}], "estimated_duration_days": "number"}',
                    contextDescription: 'Plan generation response with tasks and metadata',
                    memoryManager: memoryManagerInstance,
                    geminiService: geminiService,
                    enableAIRepair: true
                });

                parsedResponse.generation_metadata = {
                    rag_metrics: iterativeResult?.searchMetrics,
                    context_summary: finalContext.slice(0, 20).map(ctx => ({ source: ctx.sourcePath, entity: ctx.entityName, type: ctx.type, score: ctx.relevanceScore })),
                    web_sources: iterativeResult?.webSearchSources,
                    decision_log: iterativeResult?.decisionLog
                };
                parsedResponse.agent_id = agent_id;
                parsedResponse.refinement_engine_model = modelToUse;
                parsedResponse.refinement_timestamp = new Date().toISOString();
                parsedResponse.original_prompt_text = query;

                const stored_id = await geminiService.storeRefinedPrompt(parsedResponse);
                parsedResponse.refined_prompt_id = stored_id;

                const aiResponseText = formatPlanGenerationResponseToMarkdown(parsedResponse);
                // Store AI response for plan generation mode
                await conversationHistoryManager.storeConversationMessage(currentSessionId, 'ai', aiResponseText, 'text', {
                    context: finalContext,
                    execution_mode: 'plan_generation',
                    refined_prompt_id: stored_id
                });
                return { content: [{ type: 'text', text: aiResponseText }] };

            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Failed to generate plan: ${error.message}`);
            }
        }

        // Standard generative answer mode
        let finalAnswer = iterativeResult?.finalAnswer;
        let googleSearchSources: { title: string; url: string }[] = [];
        let webChunksToStore: any[] = [];

        if (!finalAnswer) {
            // Enhanced context analysis
            const ragAttemptedButFailed = (mutable_enable_rag || mutable_enable_iterative_search) && finalContext.length === 0;
            const contextRetrievalSuccessful = finalContext.length > 0;
            
            console.log(`[ask_gemini] Context Analysis: RAG attempted: ${mutable_enable_rag || mutable_enable_iterative_search}, Context retrieved: ${contextRetrievalSuccessful}, Failed retrieval: ${ragAttemptedButFailed}`);
            
            let conversationHistoryForPrompt = historyMessages.map(m => `${m.sender}: ${m.message_content}`).join('\n');
            
            // Smart context message based on actual situation
            const contextForPrompt = (() => {
                if (finalContext.length === 0) {
                    if (mutable_enable_rag || mutable_enable_iterative_search) {
                        return "RAG search was attempted but no relevant codebase context could be retrieved. Proceeding with general knowledge and reasoning capabilities.";
                    } else {
                        return "No codebase context search was performed for this query.";
                    }
                } else {
                    return formatRetrievedContextForPrompt(finalContext)[0]?.text || 'Context formatting failed.';
                }
            })();
            
            // Always include context status in conversation history when RAG is involved
            if (mutable_enable_rag || mutable_enable_iterative_search || finalContext.length > 0) {
                const contextStatusString = finalContext.length > 0 
                    ? `\n\n--- Retrieved Context ---\n${contextForPrompt}\n--- End Context ---\n`
                    : `\n\n--- Context Search Status ---\n${contextForPrompt}\n--- End Status ---\n`;
                conversationHistoryForPrompt = contextStatusString + conversationHistoryForPrompt;
            }
            
            // Smart template selection based on actual context availability and RAG attempts
            const template = (() => {
                if (ragAttemptedButFailed) {
                    // RAG was attempted but failed - use general assistant template that doesn't expect context
                    return `You are a helpful AI assistant. Please answer the user's question using your general knowledge and reasoning capabilities. 

If the question is about a specific codebase and you need additional context that isn't provided, acknowledge this limitation and:
1. Provide general guidance based on common patterns and best practices
2. Suggest what specific information would be needed for a more detailed answer
3. Offer alternative approaches or resources that might help

User Question: {query}

Conversation History (if any):
{conversation_history}`;
                } else if (hasConversationHistory && contextRetrievalSuccessful) {
                    return CONVERSATIONAL_CODEBASE_ASSISTANT_META_PROMPT;
                } else if (contextRetrievalSuccessful) {
                    return DEFAULT_CODEBASE_ASSISTANT_META_PROMPT;
                } else {
                    // No context and no RAG attempted - general mode
                    return `You are a helpful AI assistant. Please answer the user's question using your knowledge and reasoning capabilities.

User Question: {query}

Conversation History (if any):
{conversation_history}`;
                }
            })();
            
            // Log RAG failure for transparency
            if (ragAttemptedButFailed) {
                await conversationHistoryManager.storeConversationMessage(currentSessionId, 'system', 
                    `⚠️ **Context Retrieval Status**: RAG search was attempted but no relevant codebase context could be retrieved. Proceeding with general assistance mode.`, 
                    'thought', { 
                        rag_attempted: true, 
                        context_retrieved: false, 
                        fallback_mode: 'general_assistant',
                        context_items_found: finalContext.length 
                    });
            }

            let finalPrompt;
            if ((google_search || enable_web_search) && !iterativeResult) {
                // Use enhanced search prompt that combines conversation history with web search
                if (hasConversationHistory) {
                    finalPrompt = GEMINI_GOOGLE_SEARCH_PROMPT
                        .replace('{query}', query)
                        .replace('{context}', `${contextForPrompt}\n\n--- Conversation History ---\n${conversationHistoryForPrompt}\n--- End History ---`);
                } else {
                    finalPrompt = GEMINI_GOOGLE_SEARCH_PROMPT
                        .replace('{query}', query)
                        .replace('{context}', contextForPrompt);
                }
            } else {
                // Use regular codebase assistant prompt
                finalPrompt = template
                    .replace('{context}', contextForPrompt)
                    .replace('{query}', query)
                    .replace('{conversation_history}', conversationHistoryForPrompt);
            }

            // Use Gemini's built-in Google Search if requested
            let finalSystemInstruction = systemInstruction;
            let toolConfig = undefined;

            if ((google_search || enable_web_search) && !iterativeResult) {
                console.log('[ask_gemini] Using web search in ANSWER_FROM_HISTORY mode...');
                if (google_search) {
                    console.log('[ask_gemini] Using Gemini built-in Google Search...');
                    // Gemini's built-in Google Search will handle citations automatically
                    toolConfig = { tools: [{ googleSearch: {} }] };
                } else if (enable_web_search) {
                    console.log('[ask_gemini] Note: enable_web_search requires RAG mode for Tavily integration. Using Google Search instead.');
                    toolConfig = { tools: [{ googleSearch: {} }] };
                }
            }

            const geminiResponse = await geminiService.askGemini(finalPrompt, model, finalSystemInstruction, undefined, toolConfig);

            // Extract Google Search sources from Gemini's response if available
            if ((google_search || enable_web_search) && geminiResponse.groundingMetadata?.groundingChunks) {
                const chunks = geminiResponse.groundingMetadata.groundingChunks;
                googleSearchSources = chunks
                    .filter((chunk: any) => chunk.web?.uri && chunk.web?.title)
                    .map((chunk: any) => ({
                        title: chunk.web.title,
                        url: chunk.web.uri
                    }));
                webChunksToStore = chunks.map((chunk: any) => ({
                    uri: chunk.web?.uri,
                    title: chunk.web?.title,
                    content: chunk.web?.content // Assuming content might be available here
                }));
                console.log(`[ask_gemini] Gemini Google Search found ${googleSearchSources.length} sources.`);
            }

            finalAnswer = geminiResponse.content?.[0]?.text ?? 'No response could be generated.';
            
            // Enhanced user communication when RAG failed but was expected
            if (ragAttemptedButFailed && (userExplicitlyEnabledRag || userExplicitlyEnabledIterativeSearch)) {
                const contextFailureNotice = `\n\n---\n**Note**: I attempted to retrieve specific codebase context for your question, but was unable to find relevant information in the current codebase. I've provided a general response instead. If you have specific code files or documentation you'd like me to reference, please provide them directly.\n---\n`;
                finalAnswer = finalAnswer + contextFailureNotice;
            }
        }

        // Create lightweight metrics for ANSWER_FROM_HISTORY cases
        let historyMetrics = null;
        if (!iterativeResult && continue_session) {
            const webSearchPerformed = (google_search || enable_web_search) && googleSearchSources.length > 0;
            historyMetrics = {
                strategy: webSearchPerformed ? 'history_with_web_search' : 'pure_history_response',
                conversationHistoryUsed: historyMessages.length,
                webSearchSources: googleSearchSources.length,
                totalSources: googleSearchSources.length + (finalContext.length > 0 ? 1 : 0), // web sources + history
                decisionType: 'ANSWER_FROM_HISTORY',
                searchQuality: webSearchPerformed ? 0.8 : 0.7, // Estimated quality
                terminationReason: webSearchPerformed ? 'History + web search completed' : 'Conversation history sufficient',
                timestamp: new Date().toISOString()
            };
        }

        // Build the final markdown output
        // Check if finalAnswer already contains the header to avoid duplication
        let markdownOutput: string;
        if (finalAnswer.includes('## 🤖 Gemini Response')) {
            // finalAnswer already has the formatted response, use it as-is
            markdownOutput = finalAnswer;
            // Ensure it ends with a separator for analytics
            if (!markdownOutput.endsWith('---')) {
                markdownOutput += '\n\n---';
            }
        } else {
            // Add the header for raw responses
            markdownOutput = `## 🤖 Gemini Response\n\n> ${query}\n\n${finalAnswer}\n\n---`;
        }

        // Check if we have any sources to display
        const hasIterativeSources = iterativeResult?.webSearchSources && iterativeResult.webSearchSources.length > 0;
        const hasGoogleSources = googleSearchSources && googleSearchSources.length > 0;
        const hasAnySources = hasIterativeSources || hasGoogleSources;

      
        if (iterativeResult || hasAnySources || historyMetrics) {
            markdownOutput += "\n\n## 🔍 Search & Intelligence Analytics\n";

            if (iterativeResult) {
                const { searchMetrics } = iterativeResult;
                
                // Helper functions for visual indicators
                const getQualityIndicator = (score: number) => {
                    if (score >= 0.9) return "🟢 Excellent";
                    if (score >= 0.8) return "🟡 Good";
                    if (score >= 0.6) return "🟠 Fair";
                    return "🔴 Needs Improvement";
                };

                const getProgressBar = (value: number, max: number, width: number = 20) => {
                    // Ensure all values are valid numbers and within bounds
                    const safeValue = Math.max(0, isNaN(value) ? 0 : value);
                    const safeMax = Math.max(1, isNaN(max) ? 1 : max);
                    const safeWidth = Math.max(1, isNaN(width) ? 20 : width);
                    
                    const filled = Math.min(safeWidth, Math.max(0, Math.round((safeValue / safeMax) * safeWidth)));
                    const empty = Math.max(0, safeWidth - filled);
                    
                    return "█".repeat(filled) + "░".repeat(empty);
                };

                const getStatusIcon = (reason: string) => {
                    if (reason.includes("ANSWER decision")) return "✅";
                    if (reason.includes("Max iterations")) return "⏱️";
                    if (reason.includes("stable")) return "🔄";
                    if (reason.includes("Exceptional quality")) return "🌟";
                    return "ℹ️";
                };

                // Enhanced metrics display with visual elements
                markdownOutput += `\n### 📊 Performance Dashboard\n\n`;
                
                // Search completion status
                const statusIcon = getStatusIcon(searchMetrics.terminationReason);
                markdownOutput += `${statusIcon} **Search Status:** ${searchMetrics.terminationReason}\n\n`;
                
                // Core metrics table
                markdownOutput += `| Metric | Value | Progress | Status |\n`;
                markdownOutput += `|--------|-------|----------|--------|\n`;
                markdownOutput += `| ⚡ **Iterations** | ${searchMetrics.totalIterations}/5 | ${getProgressBar(searchMetrics.totalIterations, 5, 10)} | ${searchMetrics.totalIterations >= 4 ? "🔥 Thorough" : "⚡ Efficient"} |\n`;
                markdownOutput += `| 🔄 **Self-Corrections** | ${searchMetrics.selfCorrectionLoops} | ${getProgressBar(searchMetrics.selfCorrectionLoops, 3, 10)} | ${searchMetrics.selfCorrectionLoops > 0 ? "🎯 Adaptive" : "📝 Direct"} |\n`;
                markdownOutput += `| 📄 **Context Sources** | ${searchMetrics.contextItemsAdded} | ${getProgressBar(searchMetrics.contextItemsAdded, 25, 10)} | ${searchMetrics.contextItemsAdded >= 15 ? "🌟 Rich" : searchMetrics.contextItemsAdded >= 8 ? "✅ Good" : "📝 Basic"} |\n`;
                markdownOutput += `\n`;

                // Quality metrics section
                markdownOutput += `### 🎖️ Quality & Citation Analysis\n\n`;
                
                if (searchMetrics.citationAccuracy > 0 || searchMetrics.totalCitationsGenerated > 0) {
                    const citationQuality = getQualityIndicator(searchMetrics.citationAccuracy);
                    const coverageQuality = searchMetrics.citationCoverage ? getQualityIndicator(searchMetrics.citationCoverage) : "⚪ N/A";
                    
                    markdownOutput += `| Quality Metric | Score | Visual | Assessment |\n`;
                    markdownOutput += `|----------------|-------|--------|------------|\n`;
                    markdownOutput += `| 📝 **Citation Accuracy** | ${(searchMetrics.citationAccuracy * 100).toFixed(1)}% | ${getProgressBar(searchMetrics.citationAccuracy, 1, 15)} | ${citationQuality} |\n`;
                    
                    if (searchMetrics.citationCoverage !== undefined) {
                        markdownOutput += `| 📚 **Source Coverage** | ${(searchMetrics.citationCoverage * 100).toFixed(1)}% | ${getProgressBar(searchMetrics.citationCoverage, 1, 15)} | ${coverageQuality} |\n`;
                        markdownOutput += `| 🎯 **Sources Utilized** | ${searchMetrics.totalCitationsUsed}/${searchMetrics.totalCitationsGenerated} | - | ${getQualityIndicator(searchMetrics.totalCitationsUsed / Math.max(searchMetrics.totalCitationsGenerated, 1))} |\n`;
                    }
                    markdownOutput += `\n`;
                }

                // Advanced search features section
                markdownOutput += `### 🚀 Advanced Search Technologies\n\n`;
                
                const features = [];
                if (searchMetrics.hybridSearches > 0) {
                    features.push({ icon: "🔄", name: "Hybrid Search", detail: `${searchMetrics.hybridSearches} executions`, desc: "Vector + Keyword + Knowledge Graph" });
                }
                if (searchMetrics.graphTraversals > 0) {
                    features.push({ icon: "🕸️", name: "Knowledge Graph", detail: `${searchMetrics.graphTraversals} traversals`, desc: "Structured relationship analysis" });
                }
                if (searchMetrics.dmqr.enabled) {
                    const embeddingQueriesCount = searchMetrics.dmqr.generatedQueries?.length || 0;
                    features.push({ icon: "🎯", name: "DMQR Multi-Query", detail: `${embeddingQueriesCount} diverse queries`, desc: "Strategic query diversification" });
                }
                if (searchMetrics.webSearchesPerformed > 0) {
                    features.push({ icon: "🌐", name: "Web Integration", detail: `${searchMetrics.webSearchesPerformed} external searches`, desc: "Live internet knowledge" });
                }
                if (searchMetrics.hallucinationChecksPerformed > 0) {
                    features.push({ icon: "🔍", name: "Quality Reflection", detail: `${searchMetrics.hallucinationChecksPerformed} accuracy checks`, desc: "AI-powered fact verification" });
                }

                if (features.length > 0) {
                    markdownOutput += `| Technology | Usage | Description |\n`;
                    markdownOutput += `|------------|-------|-------------|\n`;
                    features.forEach(feature => {
                        markdownOutput += `| ${feature.icon} **${feature.name}** | ${feature.detail} | ${feature.desc} |\n`;
                    });
                } else {
                    markdownOutput += `📝 **Standard Retrieval:** Basic search without advanced features\n`;
                }
                markdownOutput += `\n`;
            }

            // Enhanced Web Sources Display
            if (hasGoogleSources) {
                markdownOutput += `### 🌐 External Knowledge Integration\n\n`;
                markdownOutput += `📡 **Live Web Search:** ${googleSearchSources.length} authoritative sources integrated\n\n`;

                markdownOutput += `| # | Source | URL | Type |\n`;
                markdownOutput += `|---|--------|-----|------|\n`;
                googleSearchSources.forEach((source: any, i: number) => {
                    const sourceType = source.url.includes('github.com') ? '💻 Code Repository' :
                                     source.url.includes('stackoverflow.com') ? '❓ Q&A Forum' :
                                     source.url.includes('docs.') ? '📚 Documentation' :
                                     source.url.includes('blog') ? '📝 Blog/Article' :
                                     '🌐 Web Resource';
                    
                    const truncatedTitle = source.title.length > 50 ? source.title.substring(0, 47) + '...' : source.title;
                    const truncatedUrl = source.url.length > 40 ? source.url.substring(0, 37) + '...' : source.url;
                    
                    markdownOutput += `| ${i + 1} | [${truncatedTitle}](${source.url}) | \`${truncatedUrl}\` | ${sourceType} |\n`;
                });
                markdownOutput += `\n`;
            }

            if (iterativeResult?.decisionLog && iterativeResult.decisionLog.length > 0) {
                markdownOutput += `### 🧠 Search Intelligence Trajectory\n\n`;
                markdownOutput += `🔍 **AI Decision Process:** ${iterativeResult.decisionLog.length} strategic decisions made\n\n`;

                // Decision summary table
                markdownOutput += `| Step | Decision | Quality | Strategy | Next Action |\n`;
                markdownOutput += `|------|----------|---------|----------|-------------|\n`;
                
                iterativeResult.decisionLog.forEach((log: any, index: number) => {
                    const decisionIcon = log.decision === 'ANSWER' ? '✅' : 
                                       log.decision === 'SEARCH_AGAIN' ? '🔍' : 
                                       log.decision === 'SEARCH_WEB' ? '🌐' : 
                                       log.decision === 'CORRECTIVE_SEARCH' ? '🔧' : '❓';
                    
                    const qualityScore = log.qualityScore ? `${(log.qualityScore * 100).toFixed(0)}%` : 'N/A';
                    const qualityIcon = (log.qualityScore || 0) >= 0.8 ? '🟢' : (log.qualityScore || 0) >= 0.6 ? '🟡' : '🔴';
                    
                    const strategy = log.reasoning.split('.')[0].substring(0, 50) + (log.reasoning.length > 50 ? '...' : '');
                    const nextAction = log.nextCodebaseQuery ? `🔍 "${log.nextCodebaseQuery.substring(0, 30)}..."` : 
                                     log.nextWebQuery ? `🌐 "${log.nextWebQuery.substring(0, 30)}..."` : '📝 Generate Answer';
                    
                    markdownOutput += `| ${index + 1} | ${decisionIcon} **${log.decision}** | ${qualityIcon} ${qualityScore} | ${strategy} | ${nextAction} |\n`;
                });
                markdownOutput += `\n`;

                // Expandable detailed breakdown
                markdownOutput += `<details><summary>🔬 <strong>Detailed Decision Analysis</strong> (Click to expand)</summary>\n\n`;
                
                iterativeResult.decisionLog.forEach((log: any, index: number) => {
                    const decisionIcon = log.decision === 'ANSWER' ? '✅' : 
                                       log.decision === 'SEARCH_AGAIN' ? '🔍' : 
                                       log.decision === 'SEARCH_WEB' ? '🌐' : 
                                       log.decision === 'CORRECTIVE_SEARCH' ? '🔧' : '❓';
                    const qualityIcon = (log.qualityScore || 0) >= 0.8 ? '🟢' : (log.qualityScore || 0) >= 0.6 ? '🟡' : '🔴';
                    
                    markdownOutput += `#### ${decisionIcon} Step ${index + 1}: ${log.decision}\n`;
                    markdownOutput += `**${qualityIcon} Quality Score:** ${log.qualityScore ? (log.qualityScore * 100).toFixed(1) + '%' : 'Not assessed'}\n\n`;
                    
                    markdownOutput += `**🎯 Strategic Reasoning:**\n`;
                    markdownOutput += `> ${log.reasoning}\n\n`;
                    
                    if (log.nextCodebaseQuery) {
                        markdownOutput += `**🔍 Next Codebase Query:**\n\`\`\`\n${log.nextCodebaseQuery}\n\`\`\`\n\n`;
                    }
                    if (log.nextWebQuery) {
                        markdownOutput += `**🌐 Next Web Query:**\n\`\`\`\n${log.nextWebQuery}\n\`\`\`\n\n`;
                    }
                    
                    // Extract and format specific information sections
                    if (log.reasoning.includes('Missing Information:')) {
                        const missingInfo = log.reasoning.split('Missing Information:')[1]?.split('Citation Targets:')[0]?.trim();
                        if (missingInfo) {
                            markdownOutput += `**❓ Information Gaps Identified:**\n${missingInfo.split('\n').map((line: string) => line.trim() ? `- ${line.trim()}` : '').filter(Boolean).join('\n')}\n\n`;
                        }
                    }
                    if (log.reasoning.includes('Citation Targets:')) {
                        const citationTargets = log.reasoning.split('Citation Targets:')[1]?.trim();
                        if (citationTargets) {
                            markdownOutput += `**📎 Citation Targets:** ${citationTargets}\n\n`;
                        }
                    }
                    
                    if (index < iterativeResult.decisionLog.length - 1) {
                        markdownOutput += `---\n\n`;
                    }
                });
                
                markdownOutput += `</details>\n\n`;
            }

            // Enhanced Quality Breakdown Section
            if (iterativeResult?.searchMetrics) {
                const metrics = iterativeResult.searchMetrics;
                markdownOutput += `### 📈 Performance Analytics & Quality Breakdown\n\n`;

                // Search efficiency analysis
                const efficiency = metrics.totalIterations <= 2 ? '🚀 Highly Efficient' :
                                 metrics.totalIterations <= 3 ? '⚡ Efficient' :
                                 metrics.totalIterations <= 4 ? '📊 Thorough' : '🔍 Comprehensive';

                const contextDensity = metrics.contextItemsAdded / Math.max(metrics.totalIterations, 1);
                const contextEfficiency = contextDensity >= 8 ? '🎯 Excellent' :
                                        contextDensity >= 5 ? '✅ Good' :
                                        contextDensity >= 3 ? '📝 Adequate' : '⚠️ Limited';

                markdownOutput += `**🎯 Search Efficiency Analysis:**\n`;
                markdownOutput += `- **Overall Efficiency:** ${efficiency} (${metrics.totalIterations}/5 iterations)\n`;
                markdownOutput += `- **Context Discovery Rate:** ${contextEfficiency} (${contextDensity.toFixed(1)} sources/iteration)\n`;
                markdownOutput += `- **Self-Correction Ratio:** ${metrics.selfCorrectionLoops}/${metrics.totalIterations} (${((metrics.selfCorrectionLoops / Math.max(metrics.totalIterations, 1)) * 100).toFixed(0)}%)\n\n`;

                // Citation quality analysis
                if (metrics.citationAccuracy > 0 || metrics.totalCitationsGenerated > 0) {
                    const citationScore = (metrics.citationAccuracy + (metrics.citationCoverage || 0)) / 2;
                    const citationGrade = citationScore >= 0.9 ? 'A+ Outstanding' :
                                        citationScore >= 0.8 ? 'A Excellent' :
                                        citationScore >= 0.7 ? 'B+ Good' :
                                        citationScore >= 0.6 ? 'B Fair' :
                                        citationScore >= 0.5 ? 'C Needs Improvement' : 'D Poor';

                    markdownOutput += `**📚 Citation Quality Report:**\n`;
                    markdownOutput += `- **Overall Grade:** ${citationGrade} (${(citationScore * 100).toFixed(1)}%)\n`;
                    markdownOutput += `- **Accuracy vs Coverage:** ${(metrics.citationAccuracy * 100).toFixed(1)}% accurate, ${((metrics.citationCoverage || 0) * 100).toFixed(1)}% coverage\n`;
                    markdownOutput += `- **Source Utilization:** ${metrics.totalCitationsUsed || 0}/${metrics.totalCitationsGenerated || 0} sources actively cited\n\n`;
                }

                // Advanced features utilization
                const advancedFeatures = [];
                if (metrics.hybridSearches > 0) advancedFeatures.push(`🔄 Hybrid Search (${metrics.hybridSearches}x)`);
                if (metrics.graphTraversals > 0) advancedFeatures.push(`🕸️ Knowledge Graph (${metrics.graphTraversals}x)`);
                if (metrics.dmqr.enabled) advancedFeatures.push(`🎯 DMQR Multi-Query (${metrics.dmqr.generatedQueries?.length || 0} queries)`);
                if (metrics.webSearchesPerformed > 0) advancedFeatures.push(`🌐 Web Integration (${metrics.webSearchesPerformed}x)`);
                if (metrics.hallucinationChecksPerformed > 0) advancedFeatures.push(`🔍 Quality Checks (${metrics.hallucinationChecksPerformed}x)`);

                if (advancedFeatures.length > 0) {
                    markdownOutput += `**🚀 Advanced Capabilities Utilized:**\n`;
                    advancedFeatures.forEach(feature => markdownOutput += `- ${feature}\n`);
                    markdownOutput += `\n`;
                }

                // Search strategy recommendations
                markdownOutput += `**💡 Search Strategy Insights:**\n`;
                if (metrics.totalIterations === 1 && metrics.contextItemsAdded >= 10) {
                    markdownOutput += `- ✨ **Excellent First Query:** High-quality results achieved immediately\n`;
                } else if (metrics.selfCorrectionLoops > 2) {
                    markdownOutput += `- 🔄 **Adaptive Search:** Multiple corrections led to comprehensive results\n`;
                } else if (metrics.hybridSearches > 0) {
                    markdownOutput += `- 🚀 **Multi-Modal Success:** Hybrid search enhanced result quality\n`;
                } else {
                    markdownOutput += `- 📝 **Standard Retrieval:** Effective traditional search approach\n`;
                }

                if ((metrics.citationCoverage || 0) < 0.6 && metrics.totalCitationsGenerated > 5) {
                    markdownOutput += `- ⚠️ **Improvement Opportunity:** Consider enabling more aggressive context utilization\n`;
                }
                if (metrics.totalIterations >= 4 && metrics.selfCorrectionLoops === 0) {
                    markdownOutput += `- 🎯 **Optimization Suggestion:** Self-correction could improve efficiency\n`;
                }
                markdownOutput += `\n`;
            }
        }

        // Display lightweight metrics for ANSWER_FROM_HISTORY cases
        if (historyMetrics) {
            markdownOutput += `### 🏃‍♂️ Continuation Session Analytics\n\n`;
            
            // Strategy indicator
            const strategyIcon = historyMetrics.strategy === 'history_with_web_search' ? '🌐📜' : '📜';
            const strategyName = historyMetrics.strategy === 'history_with_web_search' ? 'History + Web Search' : 'Pure History Response';
            
            markdownOutput += `**${strategyIcon} Strategy:** ${strategyName}\n`;
            markdownOutput += `**🎯 Decision:** ${historyMetrics.decisionType} (Autonomous AI choice)\n`;
            markdownOutput += `**📚 History Context:** ${historyMetrics.conversationHistoryUsed} previous messages utilized\n`;
            
            if (historyMetrics.webSearchSources > 0) {
                markdownOutput += `**🌐 Live Sources:** ${historyMetrics.webSearchSources} web sources integrated\n`;
            }
            
            markdownOutput += `**✅ Completion:** ${historyMetrics.terminationReason}\n\n`;
            
            // Quality assessment
            const qualityIcon = historyMetrics.searchQuality >= 0.8 ? '🟢' : '🟡';
            const qualityLabel = historyMetrics.searchQuality >= 0.8 ? 'High' : 'Good';
            
            markdownOutput += `### 📊 Quality Assessment\n\n`;
            markdownOutput += `| Metric | Value | Status |\n`;
            markdownOutput += `|--------|-------|--------|\n`;
            markdownOutput += `| **Quality Score** | ${(historyMetrics.searchQuality * 100).toFixed(0)}% | ${qualityIcon} ${qualityLabel} |\n`;
            markdownOutput += `| **Total Sources** | ${historyMetrics.totalSources} | ℹ️ Combined |\n`;
            markdownOutput += `| **Response Time** | Instant | ⚡ Optimized |\n\n`;
            
            // Efficiency insights
            markdownOutput += `**⚡ Efficiency Benefits:**\n`;
            markdownOutput += `- 🚀 **Instant Response:** No RAG processing overhead\n`;
            markdownOutput += `- 🧠 **Context Continuity:** Preserved conversation flow\n`;
            
            if (historyMetrics.webSearchSources > 0) {
                markdownOutput += `- 🌐 **Fresh Information:** Current web data integrated\n`;
            } else {
                markdownOutput += `- 📜 **History Sufficiency:** Complete answer from conversation context\n`;
            }
            
            markdownOutput += `- 🎯 **Smart Routing:** AI chose most efficient path\n\n`;
        }

        // Store the AI's response with complete metadata (only once)
        await conversationHistoryManager.storeConversationMessage(
            currentSessionId,
            'ai',
            markdownOutput,
            'text',
            {
                context: finalContext,
                web_chunks: webChunksToStore,
                search_metrics: iterativeResult?.searchMetrics,
                web_search_sources: iterativeResult?.webSearchSources,
                google_search_sources: googleSearchSources,
                decision_log: iterativeResult?.decisionLog,
                autonomous_focus_decision: autonomousFocusDecision,
                history_metrics: historyMetrics,
                execution_mode: 'generative_answer'
            }
        );

        return { content: [{ type: 'text', text: markdownOutput }] };
    }
};

export const geminiToolDefinitions = [askGeminiToolDefinition];

export function getGeminiToolHandlers(memoryManager: MemoryManager) {
    return {
        'ask_gemini': (args: any, agent_id?: string) => {
            if (!askGeminiToolDefinition.func) {
                throw new McpError(ErrorCode.InternalError, 'ask_gemini handler not implemented');
            }
            return askGeminiToolDefinition.func(args, memoryManager);
        }
    };
}
