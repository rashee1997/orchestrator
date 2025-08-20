import { MemoryManager } from '../database/memory_manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { InternalToolDefinition } from './index.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { RAG_DECISION_PROMPT, CODE_REVIEW_META_PROMPT, CODE_EXPLANATION_META_PROMPT, ENHANCEMENT_SUGGESTIONS_META_PROMPT, BUG_FIXING_META_PROMPT, REFACTORING_META_PROMPT, TESTING_META_PROMPT, DOCUMENTATION_META_PROMPT, DEFAULT_CODEBASE_ASSISTANT_META_PROMPT, CODE_MODULARIZATION_ORCHESTATION_META_PROMPT, GENERAL_WEB_ASSISTANT_META_PROMPT, INTENT_CLASSIFICATION_PROMPT, CONVERSATIONAL_CODEBASE_ASSISTANT_META_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { RetrievedCodeContext } from '../database/services/CodebaseContextRetrieverService.js';
import { formatRetrievedContextForPrompt } from '../database/services/gemini-integration-modules/GeminiContextFormatter.js';
import { parseGeminiJsonResponse } from '../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { REFINEMENT_MODEL_NAME } from '../database/services/gemini-integration-modules/GeminiConfig.js';
import { META_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { ContextRetrievalOptions } from '../database/services/CodebaseContextRetrieverService.js';
import { IterativeRagOrchestrator, IterativeRagResult, IterativeRagArgs } from './rag/iterative_rag_orchestrator.js';
import { RagPromptTemplates } from './rag/rag_prompt_templates.js';
import { randomUUID } from 'crypto';
import { ConversationMessage, ConversationSession } from '../database/managers/ConversationHistoryManager.js';

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
    const orchestrator = new IterativeRagOrchestrator(memoryManagerInstance, geminiService);
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
            max_iterations: { type: 'number', description: 'Max iterations for iterative search.', default: 3, minimum: 1, maximum: 5 },
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
            agent_id, query, model, systemInstruction, enable_rag, focus_area, analysis_focus_points,
            context_options, live_review_file_paths, enable_iterative_search, execution_mode,
            target_ai_persona, conversation_context_ids, enable_web_search, max_iterations,
            hallucination_check_threshold,
            google_search,
            session_id, session_name, session_sequence_number, conversation_history_limit,
            continue: continue_session
        } = args;

        // Preserve user's explicit RAG/iterative search settings
        const userExplicitlyEnabledRag = enable_rag;
        const userExplicitlyEnabledIterativeSearch = enable_iterative_search;

        let mutable_live_review_paths = live_review_file_paths ? [...live_review_file_paths] : [];
        let mutable_enable_rag = enable_rag;
        let mutable_enable_iterative_search = enable_iterative_search;

        const geminiService = memoryManagerInstance.getGeminiIntegrationService();
        if (!geminiService) {
            throw new McpError(ErrorCode.InternalError, "GeminiIntegrationService not available via MemoryManager.");
        }
        if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
            throw new McpError(ErrorCode.InternalError, "Gemini/Google API key is not set.");
        }
        const conversationHistoryManager = memoryManagerInstance.conversationHistoryManager;

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

        const userMessage = { sender: 'user', message_content: query };
        await conversationHistoryManager.storeConversationMessage(currentSessionId, userMessage.sender, userMessage.message_content);

        let conversationHistoryForPrompt = "";
        const historyMessages = await conversationHistoryManager.getConversationMessages(currentSessionId, conversation_history_limit);
        const hasConversationHistory = historyMessages.length > 0;
        let ragQuery = query;

        if (hasConversationHistory) {
            conversationHistoryForPrompt = historyMessages.map(m => `${m.sender}: ${m.message_content}`).join('\n');
            const isRagEnabledByCurrentSettings = mutable_enable_rag || mutable_enable_iterative_search || (mutable_live_review_paths && mutable_live_review_paths.length > 0);

            // Only run RAG decision prompt if user hasn't explicitly enabled RAG/iterative search
            // This ensures user's explicit intent overrides autonomous decision
            if (isRagEnabledByCurrentSettings && !userExplicitlyEnabledRag && !userExplicitlyEnabledIterativeSearch) {
                try {
                    const decisionPrompt = RAG_DECISION_PROMPT
                        .replace('{conversation_history}', conversationHistoryForPrompt)
                        .replace('{new_query}', query);

                    const decisionResult = await geminiService.askGemini(decisionPrompt, 'gemini-2.5-flash');
                    const decisionResponse = parseGeminiJsonResponse(decisionResult.content[0].text ?? '');

                    if (decisionResponse.decision === 'ANSWER_FROM_HISTORY') {
                        console.log('[ask_gemini] AI Decision: Answer from history. Skipping RAG.');
                        mutable_enable_rag = false;
                        mutable_enable_iterative_search = false;
                        mutable_live_review_paths = [];
                    } else if (decisionResponse.decision === 'PERFORM_RAG' && decisionResponse.rag_query) {
                        console.log(`[ask_gemini] AI Decision: Perform RAG with refined query: "${decisionResponse.rag_query}"`);
                        ragQuery = decisionResponse.rag_query;
                        console.log('[ask_gemini] Autonomously enabling iterative search for follow-up query.');
                        mutable_enable_iterative_search = true;
                    }
                } catch (e) {
                    console.warn('[ask_gemini] RAG decision pre-analysis failed. Proceeding with RAG by default.', e);
                }
            }
        }

        let finalContext: RetrievedCodeContext[] = [];
        let webSearchSources: { title: string; url: string }[] = [];
        let finalAnswerFromIteration: string | undefined;
        let searchMetrics: any = undefined;
        let decisionLog: any[] = [];

        try {
            // Ensure user's explicit settings are respected here
            if (userExplicitlyEnabledIterativeSearch || mutable_enable_iterative_search) {
                const iterativeResult = await _performIterativeRagSearch({ ...args, query: ragQuery }, memoryManagerInstance, geminiService);
                finalContext = iterativeResult.accumulatedContext;
                webSearchSources = iterativeResult.webSearchSources;
                finalAnswerFromIteration = iterativeResult.finalAnswer;
                searchMetrics = iterativeResult.searchMetrics;
                decisionLog = iterativeResult.decisionLog || [];
            } else if (mutable_live_review_paths?.length) {
                const embeddingService = memoryManagerInstance.getCodebaseEmbeddingService();
                for (const filePath of mutable_live_review_paths) {
                    const fileContent = await fs.readFile(filePath, 'utf-8');
                    const language = await embeddingService.introspectionService.detectLanguage(agent_id, filePath, path.basename(filePath));
                    const { chunks } = await embeddingService.chunkingService.chunkFileForMultiVector(agent_id, filePath, fileContent, path.relative(process.cwd(), filePath), language);
                    chunks.forEach((chunk, index) => {
                        finalContext.push({ type: 'file_snippet', sourcePath: filePath, entityName: `chunk_${index + 1}`, content: chunk.chunk_text, metadata: { language } });
                    });
                }
            } else if (userExplicitlyEnabledRag || mutable_enable_rag) { // Ensure user's explicit RAG is respected
                const contextRetrieverService = memoryManagerInstance.getCodebaseContextRetrieverService();
                finalContext = await contextRetrieverService.retrieveContextForPrompt(agent_id, ragQuery, context_options || {});
            }
        } catch (error: any) {
            throw new McpError(ErrorCode.InternalError, `Context Acquisition failed: ${error.message}`);
        }

        console.log(`[ask_gemini] Stage 1 complete. Acquired ${finalContext.length} context items.`);

        if (execution_mode === 'plan_generation') {
            const modelToUse = model || REFINEMENT_MODEL_NAME;
            const contextString = (formatRetrievedContextForPrompt(finalContext)[0] as { text: string })?.text || 'No relevant context was found.';
            const metaPromptContent = META_PROMPT
                .replace('{modelToUse}', modelToUse)
                .replace('{raw_user_prompt}', query)
                .replace('{retrievedCodeContextString}', contextString)
                .replace('{agentId}', agent_id);
            try {
                const result = await geminiService.askGemini(metaPromptContent, modelToUse);
                let parsedResponse = parseGeminiJsonResponse(result.content[0].text ?? '');

                parsedResponse.agent_id = agent_id;
                parsedResponse.refinement_engine_model = modelToUse;
                parsedResponse.refinement_timestamp = new Date().toISOString();
                parsedResponse.original_prompt_text = query;
                parsedResponse.target_ai_persona = target_ai_persona;
                parsedResponse.conversation_context_ids = conversation_context_ids;

                const real_stored_id = await geminiService.storeRefinedPrompt(parsedResponse);
                parsedResponse.refined_prompt_id = real_stored_id;

                const aiResponseText = JSON.stringify(parsedResponse, null, 2);

                await conversationHistoryManager.storeConversationMessage(currentSessionId, 'ai', aiResponseText, 'text', null, null, null, null, { context: finalContext.length > 0 ? finalContext : undefined });

                return { content: [{ type: 'text', text: aiResponseText }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Failed to generate plan using Gemini API: ${error.message}`);
            }
        }

        try {
            let markdownOutput = "";

            if (finalAnswerFromIteration) {
                markdownOutput = `## Gemini Response for Query:\n> "${query}"\n\n### AI Answer:\n${formatJsonToMarkdownCodeBlock(finalAnswerFromIteration, 'text')}\n\n`;
            } else {
                const canonicalContextPart = (formatRetrievedContextForPrompt(finalContext)[0] as { text: string })?.text || 'No context was provided.';
                let metaPromptTemplate: string;

                if (finalContext.length === 0 && !hasConversationHistory) {
                    metaPromptTemplate = `{query}`;
                } else if (webSearchSources.length > 0) {
                    metaPromptTemplate = GENERAL_WEB_ASSISTANT_META_PROMPT;
                } else if (hasConversationHistory) {
                    metaPromptTemplate = CONVERSATIONAL_CODEBASE_ASSISTANT_META_PROMPT;
                } else {
                    metaPromptTemplate = DEFAULT_CODEBASE_ASSISTANT_META_PROMPT;
                }

                const finalPromptContent = metaPromptTemplate
                    .replace('{context}', canonicalContextPart)
                    .replace('{query}', query)
                    .replace('{conversation_history}', conversationHistoryForPrompt);

                const toolConfig = google_search ? { tools: [{ googleSearch: {} }] } : undefined;
                const geminiResponse = await geminiService.askGemini(finalPromptContent, model, systemInstruction, undefined, toolConfig);
                const geminiText = geminiResponse.content?.[0]?.text ?? '';
                
                // Extract grounding metadata if available
                let citations: Array<{ title: string; url: string }> = [];
                if (google_search && geminiResponse.groundingMetadata?.groundingChunks) {
                    for (const chunk of geminiResponse.groundingMetadata.groundingChunks) {
                        if (chunk.web?.uri && chunk.web?.title) {
                            citations.push({
                                title: chunk.web.title,
                                url: chunk.web.uri
                            });
                        }
                    }
                }
                
                markdownOutput = `## Gemini Response for Query:\n> "${query}"\n\n### AI Answer:\n${formatJsonToMarkdownCodeBlock(geminiText, 'text')}\n\n`;
                
                // Add citations section if available
                if (citations.length > 0) {
                    markdownOutput += `### Citations:\n`;
                    citations.forEach((citation, index) => {
                        markdownOutput += `${index + 1}. [${citation.title}](${citation.url})\n`;
                    });
                    markdownOutput += `\n`;
                }
            }
            
            const isContextProvided = finalContext.length > 0;
            if (isContextProvided) {
                const canonicalContextPart = (formatRetrievedContextForPrompt(finalContext)[0] as { text: string })?.text;
                const answerToCheck = finalAnswerFromIteration || markdownOutput.split('### AI Answer:')[1];
                const verificationPrompt = RagPromptTemplates.generateVerificationPrompt({ originalQuery: query, contextString: canonicalContextPart, generatedAnswer: answerToCheck });
                const verificationResult = await geminiService.askGemini(verificationPrompt, model, "You are a precise fact-checker. Respond only with VERIFIED or HALLUCINATION_DETECTED followed by issues.");
                const verificationText = verificationResult.content[0].text ?? "";

                if (verificationText.includes("HALLUCINATION_DETECTED")) {
                    markdownOutput += `**Warning:** Potential hallucinations detected:\n${formatJsonToMarkdownCodeBlock(verificationText.replace("HALLUCINATION_DETECTED", "").trim(), 'text')}\n`;
                } else {
                    markdownOutput += `**Verification Status:** Verified against provided context.\n`;
                }
            }

            if (searchMetrics) {
                markdownOutput += `\n### Search Metrics:\n- Total Iterations: ${searchMetrics.totalIterations}\n- Context Items Added: ${searchMetrics.contextItemsAdded}\n- Web Searches Performed: ${searchMetrics.webSearchesPerformed}\n- Hallucination Checks Passed: ${searchMetrics.hallucinationChecksPassed}\n`;
                if (searchMetrics.earlyTerminationReason) markdownOutput += `- Early Termination Reason: ${searchMetrics.earlyTerminationReason}\n`;
            }

            if (webSearchSources.length > 0) {
                markdownOutput += `\n### Web Search Sources:\n` + webSearchSources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n');
            }

            await conversationHistoryManager.storeConversationMessage(currentSessionId, 'ai', markdownOutput, 'text', null, null, null, null, {
                context: finalContext.length > 0 ? finalContext : undefined,
                sources: webSearchSources.length > 0 ? webSearchSources : undefined,
                metrics: searchMetrics,
                decisionLog: decisionLog.length > 0 ? decisionLog : undefined,
                finalAnswerContent: finalAnswerFromIteration,
            });

            return { content: [{ type: 'text', text: markdownOutput }] };
        } catch (error: any) {
            throw new McpError(ErrorCode.InternalError, `Gemini API Error: ${error.message}`);
        }
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