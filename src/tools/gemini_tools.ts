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
import { parseGeminiJsonResponse } from '../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { REFINEMENT_MODEL_NAME } from '../database/services/gemini-integration-modules/GeminiConfig.js';
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
        const result = await geminiService.askGemini(classificationPrompt, 'gemini-2.5-flash');
        const intent = result.content[0].text?.trim() || '';
        if (VALID_FOCUS_AREAS.includes(intent)) {
            return intent;
        }
        console.warn(`[ask_gemini] Intent classification returned an invalid focus area: "${intent}". Falling back to default.`);
        return null;
    } catch (error) {
        console.error(`[ask_gemini] Error during AI-powered intent classification:`, error);
        return null;
    }
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
            model: { type: 'string', description: 'Optional: The Gemini model to use.', default: 'gemini-2.5-flash' },
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
                default: 3,
                minimum: 1,
                maximum: 5
            },
            enable_dmqr: {
                type: 'boolean',
                description: 'Enable Diverse Multi-Query Rewriting (DMQR) for the initial RAG context.',
                default: false
            },
            dmqr_query_count: {
                type: 'number',
                description: 'The number of diverse queries to generate for DMQR.',
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
                    embeddingScoreThreshold: { type: 'number', nullable: true }
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
            google_search: { type: 'boolean', description: 'Optional: If true, enables Google Search via Tavily for the query.', default: false, nullable: true },
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
            continue: continue_session
        } = args;

        let focus_area = args.focus_area; // Make focus_area mutable

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

        const historyMessages = await conversationHistoryManager.getConversationMessages(currentSessionId, conversation_history_limit);
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
                    .replace('{new_query}', query);

                const decisionResult = await geminiService.askGemini(decisionPrompt, 'gemini-2.5-flash');
                const decisionResponse = parseGeminiJsonResponse(decisionResult.content[0].text ?? '');

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
                    console.log('[ask_gemini] ✅ AI Decision: Answer from history. Skipping RAG.');
                    mutable_enable_rag = false;
                    mutable_enable_iterative_search = false;
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
                console.log('[ask_gemini] Calling _performIterativeRagSearch...');
                iterativeResult = await _performIterativeRagSearch({ ...args, query: ragQuery }, memoryManagerInstance, geminiService);
                finalContext = iterativeResult.accumulatedContext;
                console.log(`[ask_gemini] _performIterativeRagSearch returned iterativeResult. SearchMetrics: ${JSON.stringify(iterativeResult.searchMetrics)}`);
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
                const parsedResponse = parseGeminiJsonResponse(result.content[0].text ?? '');

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
                await conversationHistoryManager.storeConversationMessage(currentSessionId, 'ai', aiResponseText, 'text', { context: finalContext });
                return { content: [{ type: 'text', text: aiResponseText }] };

            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Failed to generate plan: ${error.message}`);
            }
        }

        // Standard generative answer mode
        let finalAnswer = iterativeResult?.finalAnswer;
        let googleSearchSources: { title: string; url: string }[] = [];

        if (!finalAnswer) {
            const conversationHistoryForPrompt = historyMessages.map(m => `${m.sender}: ${m.message_content}`).join('\n');
            const contextForPrompt = formatRetrievedContextForPrompt(finalContext)[0]?.text || 'No context was provided.';
            const template = hasConversationHistory ? CONVERSATIONAL_CODEBASE_ASSISTANT_META_PROMPT : DEFAULT_CODEBASE_ASSISTANT_META_PROMPT;

            let finalPrompt;
            if (google_search && !iterativeResult) {
                // Use Gemini's Google Search prompt for Google searches
                finalPrompt = GEMINI_GOOGLE_SEARCH_PROMPT
                    .replace('{query}', query)
                    .replace('{context}', contextForPrompt);
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

            if (google_search && !iterativeResult) {
                console.log('[ask_gemini] Using Gemini built-in Google Search...');
                // Gemini's built-in Google Search will handle citations automatically
                toolConfig = { tools: [{ googleSearch: {} }] };
            }

            const geminiResponse = await geminiService.askGemini(finalPrompt, model, finalSystemInstruction, undefined, toolConfig);

            // Extract Google Search sources from Gemini's response if available
            if (google_search && geminiResponse.groundingMetadata?.groundingChunks) {
                const chunks = geminiResponse.groundingMetadata.groundingChunks;
                googleSearchSources = chunks
                    .filter((chunk: any) => chunk.web?.uri && chunk.web?.title)
                    .map((chunk: any) => ({
                        title: chunk.web.title,
                        url: chunk.web.uri
                    }));
                console.log(`[ask_gemini] Gemini Google Search found ${googleSearchSources.length} sources.`);
            }

            finalAnswer = geminiResponse.content?.[0]?.text ?? 'No response could be generated.';
        }

        // Build the final markdown output
        let markdownOutput = `## Gemini Response\n\n> "${query}"\n\n### AI Answer\n${finalAnswer}\n\n---`;

        // Check if we have any sources to display
        const hasIterativeSources = iterativeResult?.webSearchSources && iterativeResult.webSearchSources.length > 0;
        const hasGoogleSources = googleSearchSources && googleSearchSources.length > 0;
        const hasAnySources = hasIterativeSources || hasGoogleSources;

        if (iterativeResult || hasAnySources) {
            markdownOutput += "\n\n### Search & Reasoning Trajectory\n";

            if (iterativeResult) {
                const { searchMetrics } = iterativeResult;
                markdownOutput += `\n**RAG Metrics:**\n`;
                markdownOutput += `- **Termination Reason:** ${searchMetrics.terminationReason}\n`;
                markdownOutput += `- **Total Iterations:** ${searchMetrics.totalIterations}\n`;
                markdownOutput += `- **Self-Correction Loops:** ${searchMetrics.selfCorrectionLoops}\n`;
                markdownOutput += `- **Context Items Found:** ${searchMetrics.contextItemsAdded}\n`;
                if (searchMetrics.dmqr.enabled) {
                    markdownOutput += `- **DMQR:** Enabled (${searchMetrics.dmqr.generatedQueries?.length} queries)\n`;
                }
                if (searchMetrics.webSearchesPerformed > 0) {
                    markdownOutput += `- **Iterative Web Searches:** ${searchMetrics.webSearchesPerformed}\n`;
                }
            }

            // Display Google Search sources if available
            if (hasGoogleSources) {
                markdownOutput += `- **Gemini Google Searches:** ${googleSearchSources.length}\n`;
            }

            // Display all sources
            if (hasAnySources) {
                markdownOutput += "\n**Sources:**\n";

                // Display iterative RAG sources first
                if (hasIterativeSources) {
                    markdownOutput += "**Iterative RAG Sources:**\n";
                    iterativeResult!.webSearchSources.forEach((source: any, i: number) => {
                        markdownOutput += `${i + 1}. **[${source.title}](${source.url})**\n`;
                    });
                    if (hasGoogleSources) markdownOutput += "\n";
                }

                // Display Google Search sources
                if (hasGoogleSources) {
                    markdownOutput += "**Gemini Google Search Sources:**\n";
                    googleSearchSources.forEach((source: any, i: number) => {
                        const index = (hasIterativeSources ? iterativeResult!.webSearchSources.length : 0) + i + 1;
                        markdownOutput += `${index}. **[${source.title}](${source.url})**\n`;
                    });
                }
            }

            if (iterativeResult?.decisionLog && iterativeResult.decisionLog.length > 0) {
                markdownOutput += "\n**Decision Log:**\n";
                iterativeResult.decisionLog.forEach((log, i) => {
                    markdownOutput += `${i + 1}. **Decision:** ${log.decision} - **Reasoning:** ${log.reasoning}\n`;
                });
            }
        }

        await conversationHistoryManager.storeConversationMessage(currentSessionId, 'ai', markdownOutput, 'text', {
            context: finalContext,
            sources: iterativeResult?.webSearchSources,
            metrics: iterativeResult?.searchMetrics,
            decisionLog: iterativeResult?.decisionLog,
            autonomousFocusDecision: autonomousFocusDecision,
        });

        return { content: [{ type: 'text', text: markdownOutput }] };
    }
};

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

export const geminiToolDefinitions: InternalToolDefinition[] = [
    {
        name: askGeminiToolDefinition.name,
        description: askGeminiToolDefinition.description,
        inputSchema: askGeminiToolDefinition.inputSchema
    }
];
