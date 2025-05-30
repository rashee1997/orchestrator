// src/services/CodebaseContextRetrieverService.ts
import { MemoryManager } from '../memory_manager.js';
import { CodebaseEmbeddingService } from './CodebaseEmbeddingService.js';
import { IKnowledgeGraphManager } from '../factories/KnowledgeGraphFactory.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
// Potentially import other necessary types or services

/**
 * Options for configuring context retrieval.
 */
export interface ContextRetrievalOptions {
    /** Maximum number of results to return from embedding search. */
    topKEmbeddings?: number;
    /** Depth for Knowledge Graph traversal if applicable. */
    kgQueryDepth?: number;
    /** Whether to include full file content for file nodes retrieved from KG. */
    includeFileContent?: boolean;
    /** Specific file paths (relative to project root) to restrict embedding search. */
    targetFilePaths?: string[];
    /** Maximum number of KG search results. */
    topKKgResults?: number;
    /** Threshold for embedding relevance score. */
    embeddingScoreThreshold?: number;
}

/**
 * Represents a piece of retrieved codebase context.
 */
export interface RetrievedCodeContext {
    /** The type of context retrieved. */
    type: 'file_snippet' | 'function_definition' | 'class_definition' | 'interface_definition' | 'enum_definition' | 'type_alias_definition' | 'variable_definition' | 'kg_node_info' | 'directory_structure' | 'import_statement' | 'generic_code_chunk';
    /** The relative path to the source file from the project root. */
    sourcePath: string;
    /** The name of the specific code entity (e.g., function name, class name), if applicable. */
    entityName?: string;
    /** The actual content snippet (e.g., code, KG node observation). */
    content: string;
    /** A score indicating the relevance of this context, typically from embedding search. */
    relevanceScore?: number;
    /** Additional metadata, e.g., line numbers, KG node type, language. */
    metadata?: {
        startLine?: number;
        endLine?: number;
        language?: string;
        kgNodeType?: string; // e.g., 'file', 'function', 'class' from KG
        [key: string]: any;
    };
}

/**
 * Represents a Knowledge Graph node structure as returned by KnowledgeGraphManager.
 */
interface KGNode {
    node_id: string;
    name: string;
    entityType: string;
    observations: string[];
}

/**
 * Service responsible for retrieving relevant codebase context.
 * It uses both semantic search (vector embeddings) and structured Knowledge Graph queries.
 */
export class CodebaseContextRetrieverService {
    private memoryManager: MemoryManager;
    private embeddingService: CodebaseEmbeddingService;
    private kgManager: IKnowledgeGraphManager;
    private geminiService?: GeminiIntegrationService; // Optional, for advanced processing

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
        
        try {
            this.embeddingService = memoryManager.getCodebaseEmbeddingService();
        } catch (error) {
            console.warn("CodebaseContextRetrieverService: CodebaseEmbeddingService not available, semantic search will be disabled.");
            this.embeddingService = null as any;
        }
        
        try {
            this.kgManager = memoryManager.knowledgeGraphManager;
        } catch (error) {
            console.warn("CodebaseContextRetrieverService: KnowledgeGraphManager not available, KG search will be disabled.");
            this.kgManager = null as any;
        }
        
        // Optionally initialize GeminiService if needed for tasks like keyword extraction
        // or intelligent combination of results within this service.
        try {
            this.geminiService = memoryManager.getGeminiIntegrationService();
        } catch (error) {
            console.warn("CodebaseContextRetrieverService: GeminiIntegrationService not available, some advanced features might be disabled.");
            this.geminiService = undefined;
        }
    }

    /**
     * Retrieves relevant codebase context based on a natural language prompt.
     * This method will orchestrate calls to semantic search and KG queries.
     * @param agentId The ID of the agent.
     * @param prompt The natural language prompt.
     * @param options Optional retrieval configurations.
     * @returns A promise resolving to an array of RetrievedCodeContext.
     */
    public async retrieveContextForPrompt(
        agentId: string,
        prompt: string,
        options?: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        console.log(`Retrieving context for prompt (agent: ${agentId}): "${prompt.substring(0, 100)}..."`);
        const retrievedContexts: RetrievedCodeContext[] = [];

        // 1. Extract keywords/entities from prompt (placeholder - can use Gemini or simpler NLP)
        const keywords = this.extractKeywordsFromPrompt(prompt); // Placeholder
        console.log('[DEBUG] Extracted keywords:', keywords);

        // 2. Perform semantic search using CodebaseEmbeddingService
        if (keywords.length > 0 && this.embeddingService) {
            try {
                const semanticQuery = keywords.join(' '); // Or use the full prompt
                const embeddingResults = await this.embeddingService.retrieveSimilarCodeChunks(
                    agentId,
                    semanticQuery,
                    options?.topKEmbeddings ?? 5,
                    options?.targetFilePaths
                );
                console.log(`Raw embedding results count: ${embeddingResults.length}`);
                console.log(`Raw embedding results:`, JSON.stringify(embeddingResults, null, 2));


                embeddingResults.forEach(embResult => {
                    if (options?.embeddingScoreThreshold && embResult.score < options.embeddingScoreThreshold) {
                        console.log(`Skipping embedding result due to low score: ${embResult.score} < ${options.embeddingScoreThreshold}`);
                        return; // Skip if below threshold
                    }
                    let type: RetrievedCodeContext['type'] = 'generic_code_chunk';
                    let metadata: RetrievedCodeContext['metadata'] = {
                        language: undefined, // Placeholder, could try to infer
                    };

                    if (embResult.metadata_json) {
                        try {
                            const embMetadata = JSON.parse(embResult.metadata_json);
                            metadata = { ...metadata, ...embMetadata };
                            if (embMetadata.type === 'function' || embMetadata.type === 'method') type = 'function_definition';
                            else if (embMetadata.type === 'class') type = 'class_definition';
                            else if (embMetadata.type === 'interface') type = 'interface_definition';
                            // Add more type mappings based on your chunking metadata
                        } catch (e) {
                            console.warn(`Failed to parse metadata_json for embedding: ${embResult.metadata_json}`);
                        }
                    }

                    const newContextItem = {
                        type: type,
                        sourcePath: embResult.file_path_relative,
                        entityName: embResult.entity_name || undefined,
                        content: embResult.chunk_text,
                        relevanceScore: embResult.score,
                        metadata: metadata,
                    };
                    retrievedContexts.push(newContextItem);
                    console.log(`Added embedding context item: ${newContextItem.sourcePath} - ${newContextItem.entityName || newContextItem.type} (Score: ${newContextItem.relevanceScore})`);
                });
                console.log(`Retrieved ${embeddingResults.length} items from semantic search.`);
            } catch (error) {
                console.error(`Error during semantic search for prompt context:`, error);
            }
        }

        // 3. Perform Knowledge Graph searches
        // Example: Search for KG nodes matching keywords (names or observations)
        if (keywords.length > 0 && this.kgManager) {
            try {
                const kgNodes = await this.kgManager.searchNodes(agentId, keywords.join(' ')); // Simple OR search for now
                console.log(`Raw KG search results count: ${kgNodes.length}`);
                console.log(`Raw KG search results:`, JSON.stringify(kgNodes, null, 2));
                
                kgNodes.slice(0, options?.topKKgResults ?? 5).forEach((node: KGNode) => {
                    let nodeContent = `Entity Type: ${node.entityType}\nObservations:\n`;
                    if (Array.isArray(node.observations)) {
                        nodeContent += node.observations.map((obs: string) => `- ${obs}`).join('\n');
                    } else {
                        nodeContent += String(node.observations);
                    }

                    // Attempt to map KG entityType to RetrievedCodeContext['type']
                    let contextType: RetrievedCodeContext['type'] = 'kg_node_info';
                    if (node.entityType === 'file') contextType = 'file_snippet'; // Could be refined
                    else if (node.entityType === 'function' || node.entityType === 'method') contextType = 'function_definition';
                    else if (node.entityType === 'class') contextType = 'class_definition';
                    // ... add more mappings

                    const newContextItem = {
                        type: contextType,
                        sourcePath: node.name, // KG node name is often the relative path for files
                        entityName: node.entityType !== 'file' ? node.name : undefined, // If it's not a file, the name is the entity name
                        content: nodeContent,
                        relevanceScore: 0.7, // Placeholder, KG results might not have a direct score like embeddings
                        metadata: {
                            kgNodeType: node.entityType,
                            // Potentially extract language from observations if available
                        },
                    };
                    retrievedContexts.push(newContextItem);
                    console.log(`Added KG context item: ${newContextItem.sourcePath} - ${newContextItem.entityName || newContextItem.type}`);
                });
                 console.log(`Retrieved ${kgNodes.length} KG nodes matching keywords.`);
            } catch (error) {
                console.error(`Error during KG search for prompt context:`, error);
            }
        }

        // 4. Combine and rank results (placeholder for more sophisticated ranking)
        // For now, just sort by relevanceScore if available, then by type or sourcePath
        retrievedContexts.sort((a, b) => {
            if (a.relevanceScore && b.relevanceScore) {
                return b.relevanceScore - a.relevanceScore;
            }
            if (a.relevanceScore) return -1;
            if (b.relevanceScore) return 1;
            return a.sourcePath.localeCompare(b.sourcePath);
        });
        
        // Deduplicate results (simple deduplication based on content and sourcePath for now)
        const uniqueContexts = Array.from(new Map(retrievedContexts.map(item => [`${item.sourcePath}#${item.entityName || ''}#${item.content.substring(0,100)}`, item])).values());

        console.log('[DEBUG] Returning', uniqueContexts.length, 'unique context items.');
        return uniqueContexts.slice(0, (options?.topKEmbeddings ?? 5) + (options?.topKKgResults ?? 5)); // Limit total results
    }

    /**
     * A simple keyword extraction method.
     * In a real scenario, this might involve more sophisticated NLP or an LLM call.
     * @param prompt The prompt string.
     * @returns An array of keywords.
     */
    private extractKeywordsFromPrompt(prompt: string): string[] {
        // Reduced stop word list to allow more technical terms to pass through
        const stopWords = new Set([
            'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
            'can', 'could', 'may', 'might', 'must', 'in', 'on', 'at', 'by', 'for',
            'with', 'about', 'to', 'from', 'into', 'out', 'of', 'up', 'down',
            'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
            'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
            'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
            'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'just', 'don',
            'now', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
            'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us',
            'them', 'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours',
            'hers', 'ours', 'theirs', 'myself', 'yourself', 'himself', 'herself',
            'itself', 'ourselves', 'yourselves', 'themselves', 'please', 'give',
            'me', 'about', 'regarding', 'concerning', 'related', 'based', 'on',
            'using', 'via', 'that', 'which', 'how', 'can', 'i', 'and', 'or', 'but',
            'if', 'else', 'while', 'for', 'switch', 'case', 'default', 'try', 'catch',
            'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'void',
            'null', 'undefined', 'true', 'false', 'help', 'explain', 'understand',
            'meaning', 'definition', 'purpose', 'reason', 'logic', 'flow', 'structure',
            'design', 'architecture', 'pattern', 'best', 'practice', 'convention',
            'standard', 'guideline', 'rule', 'policy', 'procedure', 'process', 'step',
            'task', 'action', 'operation', 'command', 'instruction', 'request', 'query',
            'question', 'answer', 'response', 'result', 'output', 'input', 'data',
            'information', 'context', 'detail', 'summary', 'overview', 'report',
            'analysis', 'review', 'test', 'debug', 'fix', 'change', 'update', 'modify',
            'add', 'remove', 'delete', 'create', 'generate', 'implement', 'develop',
            'build', 'refactor', 'optimize', 'improve', 'enhance', 'ensure', 'verify',
            'validate', 'check', 'confirm', 'compare', 'contrast', 'differentiate',
            'relate', 'connect', 'link', 'associate', 'integrate', 'combine', 'merge',
            'split', 'separate', 'extract', 'parse', 'transform', 'convert', 'format',
            'display', 'show', 'hide', 'log', 'store', 'save', 'load', 'retrieve',
            'fetch', 'get', 'set', 'find', 'search', 'locate', 'identify', 'detect',
            'recognize', 'monitor', 'track', 'manage', 'control', 'handle', 'process',
            'execute', 'run', 'start', 'stop', 'pause', 'resume', 'continue', 'cancel',
            'abort', 'reset', 'configure', 'setup', 'install', 'uninstall', 'deploy',
            'publish', 'release', 'version', 'upgrade', 'downgrade', 'migrate', 'backup',
            'restore', 'synchronize', 'share', 'collaborate', 'communicate', 'notify',
            'alert', 'warn', 'inform', 'advise', 'suggest', 'recommend', 'propose',
            'offer', 'provide', 'support', 'assist', 'aid', 'serve', 'give', 'present',
            'donate', 'contribute', 'distribute', 'deliver', 'send', 'transmit', 'receive',
            'accept', 'take', 'obtain', 'acquire', 'collect', 'gather', 'accumulate',
            'keep', 'hold', 'possess', 'own', 'belong', 'lose', 'misplace', 'forget',
            'remember', 'recall', 'recognize', 'distinguish', 'sense', 'feel', 'touch',
            'taste', 'smell', 'hear', 'listen', 'read', 'draw', 'paint', 'sculpt',
            'carve', 'engrave', 'print', 'type', 'photograph', 'film', 'record', 'play',
            'sing', 'dance', 'act', 'perform', 'compose', 'arrange', 'conduct', 'direct',
            'produce', 'edit', 'broadcast', 'telecast', 'stream', 'download', 'upload',
            'post', 'like', 'dislike', 'comment', 'subscribe', 'follow', 'unfollow',
            'friend', 'unfriend', 'block', 'report', 'flag', 'mute', 'unmute', 'pin',
            'unpin', 'tag', 'mention', 'reply', 'forward', 'retweet', 'repost', 'favorite',
            'bookmark', 'archive', 'erase', 'clear', 'empty', 'fill', 'insert', 'append',
            'prepend', 'cut', 'copy', 'paste', 'undo', 'redo', 'sort', 'filter', 'group', 'ungroup',
            'move', 'drag', 'drop', 'resize', 'rotate', 'crop', 'zoom', 'pan', 'scroll',
            'navigate', 'browse', 'open', 'close', 'minimize', 'maximize', 'restore',
            'switch', 'select', 'deselect', 'tap', 'double-click', 'double-tap', 'press',
            'hold', 'release', 'swipe', 'pinch', 'spread', 'hover', 'focus', 'blur',
            'submit', 'decline', 'approve', 'reject', 'next', 'previous', 'back', 'forward',
            'home', 'end', 'page-up', 'page-down', 'tab', 'enter', 'escape', 'space',
            'shift', 'ctrl', 'alt', 'cmd', 'option', 'fn', 'caps-lock', 'num-lock',
            'scroll-lock', 'print-screen', 'pause', 'break', 'insert', 'delete', 'backspace',
            'menu', 'context-menu', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9',
            'F10', 'F11', 'F12'
        ]);

        const words = prompt.toLowerCase().replace(/[^\w\s'-]|(?<=\w)-(?=\w)|(?<=')-(?=\w)|(?<=\w)-(?=')/g, "").split(/\s+/);
        const significantWords = words.filter(word => word.length > 2 && !stopWords.has(word));
        
        // Further refinement: identify potential entity names (e.g., CamelCase, snake_case, paths)
        const potentialEntities = prompt.match(/([A-Za-z0-9_]+\.[A-Za-z0-9_]+)|([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)|([a-z0-9_]+_[a-z0-9_]+)/g) || [];
        
        return Array.from(new Set([...significantWords, ...potentialEntities]));
    }

    /**
     * Retrieves relevant codebase context based on a list of keywords.
     * @param agentId The ID of the agent.
     * @param keywords An array of keywords.
     * @param options Optional retrieval configurations.
     * @returns A promise resolving to an array of RetrievedCodeContext.
     */
    public async retrieveContextByKeywords(
        agentId: string,
        keywords: string[],
        options?: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        if (!keywords || keywords.length === 0) {
            return [];
        }
        // This can be a simplified version of retrieveContextForPrompt,
        // focusing on the parts that use the pre-defined keywords.
        const promptFromKeywords = keywords.join(' ');
        return this.retrieveContextForPrompt(agentId, promptFromKeywords, options);
    }

    /**
     * Retrieves context for specific code entities by their names from the Knowledge Graph.
     * @param agentId The ID of the agent.
     * @param entityNames An array of entity names (e.g., "src/utils/formatters.ts::formatTaskToMarkdown").
     * @param options Optional retrieval configurations.
     * @returns A promise resolving to an array of RetrievedCodeContext.
     */
    public async retrieveContextByEntityNames(
        agentId: string,
        entityNames: string[],
        options?: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        if (!entityNames || entityNames.length === 0) {
            return [];
        }
        const retrievedContexts: RetrievedCodeContext[] = [];
        
        if (!this.kgManager) {
            console.warn("KnowledgeGraphManager not available, cannot retrieve context by entity names");
            return [];
        }
        
        try {
            const kgNodes = await this.kgManager.openNodes(agentId, entityNames);
            kgNodes.forEach((node: KGNode) => {
                let nodeContent = `Entity Type: ${node.entityType}\nObservations:\n`;
                 if (Array.isArray(node.observations)) {
                    nodeContent += node.observations.map((obs: string) => `- ${obs}`).join('\n');
                } else {
                    nodeContent += String(node.observations);
                }

                let contextType: RetrievedCodeContext['type'] = 'kg_node_info';
                if (node.entityType === 'file') contextType = 'file_snippet';
                else if (node.entityType === 'function' || node.entityType === 'method') contextType = 'function_definition';
                else if (node.entityType === 'class') contextType = 'class_definition';

                retrievedContexts.push({
                    type: contextType,
                    sourcePath: node.name, // Assuming KG node name is the unique identifier/path
                    entityName: node.entityType !== 'file' ? node.name : undefined,
                    content: nodeContent, // Placeholder, ideally fetch actual code if options.includeFileContent
                    relevanceScore: 0.7, // Placeholder, KG results might not have a direct score like embeddings
                    metadata: { kgNodeType: node.entityType },
                });
            });
        } catch (error) {
            console.error(`Error retrieving KG nodes by names:`, error);
        }
        return retrievedContexts;
    }
}
