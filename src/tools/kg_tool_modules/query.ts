import { MemoryManager } from '../../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeGraphQueryProducer } from '../rag/kg_query_producer.js';
import { GraphTraversalNode } from '../../types/query.js';
import { formatJsonToMarkdownCodeBlock } from '../../utils/formatters.js';
import { parseGeminiJsonResponseSync } from '../../database/services/gemini-integration-modules/GeminiResponseParsers.js';

export function getQueryHandlers(memoryManager: MemoryManager) {
    return {
        'kg_nl_query': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for kg_nl_query.");
            }

            const { query, model, enable_dmqr, dmqr_query_count } = args;

            try {
                let allResults: any[] = [];
                let queryMetrics = {
                    totalQueries: 1,
                    dmqrEnabled: !!enable_dmqr,
                    processingTimeMs: 0
                };

                const startTime = Date.now();

                if (enable_dmqr) {
                    console.log(`[kg_nl_query] DMQR enabled. Generating ${dmqr_query_count || 3} diverse KG queries for: "${query}"`);
                    
                    const geminiService = memoryManager.getGeminiIntegrationService();
                    if (!geminiService) {
                        throw new McpError(ErrorCode.InternalError, "GeminiIntegrationService not available for DMQR.");
                    }

                    // Generate diverse KG queries
                    const kgQueryProducer = new KnowledgeGraphQueryProducer(geminiService);
                    const kgQueryResult = await kgQueryProducer.generateKGQueries(query, {
                        queryCount: dmqr_query_count || 3
                    });

                    // Combine all types of KG queries
                    const allKGQueries = [
                        ...kgQueryResult.structuralQueries,
                        ...kgQueryResult.semanticQueries,
                        ...kgQueryResult.hybridQueries
                    ];

                    queryMetrics.totalQueries = allKGQueries.length;
                    console.log(`[kg_nl_query] Generated ${allKGQueries.length} diverse KG queries:`, allKGQueries.map(q => q.query));

                    // Execute each diverse query
                    for (const kgQuery of allKGQueries) {
                        try {
                            console.log(`[kg_nl_query] Executing KG query (${kgQuery.searchStrategy}): "${kgQuery.query}"`);
                            const resultJsonString = await memoryManager.knowledgeGraphManager.queryNaturalLanguage(agent_id, kgQuery.query);
                            const result = parseGeminiJsonResponseSync(resultJsonString);
                            
                            // Add metadata about the query source
                            if (result.metadata) {
                                result.metadata.dmqrSource = {
                                    originalQuery: query,
                                    diverseQuery: kgQuery.query,
                                    searchStrategy: kgQuery.searchStrategy,
                                    confidence: kgQuery.confidence,
                                    focusAreas: kgQuery.focusAreas
                                };
                            }
                            
                            allResults.push(result);
                        } catch (queryError: any) {
                            console.warn(`[kg_nl_query] DMQR query failed for "${kgQuery.query}":`, queryError);
                            // Continue with other queries
                        }
                    }
                } else {
                    // Standard single query execution
                    const resultJsonString = await memoryManager.knowledgeGraphManager.queryNaturalLanguage(agent_id, query);
                    const result = parseGeminiJsonResponseSync(resultJsonString);
                    allResults.push(result);
                }

                queryMetrics.processingTimeMs = Date.now() - startTime;

                // Process and format results
                let md = `## Natural Language Query Result for Agent: \`${agent_id}\`
`;
                md += `**Query:** "${query}"${enable_dmqr ? ` (DMQR enabled: ${queryMetrics.totalQueries} queries)` : ''}
`;

                if (enable_dmqr) {
                    md += `### DMQR Metrics
`;
                    md += `- **Total Queries Generated:** ${queryMetrics.totalQueries}
`;
                    md += `- **Processing Time:** ${queryMetrics.processingTimeMs}ms
`;
                    md += `- **Results Found:** ${allResults.filter(r => r.results && !r.results.error).length}
`;
                }

                // Combine and deduplicate results
                const combinedResults = {
                    nodes: new Map(),
                    relations: new Map(),
                    metadata: allResults.length > 0 ? allResults[0].metadata : null
                };

                let hasResults = false;
                allResults.forEach((result, index) => {
                    if (result.results && !result.results.error) {
                        hasResults = true;
                        if (result.results.nodes) {
                            result.results.nodes.forEach((node: any) => {
                                const nodeKey = `${node.name}::${node.entityType}`;
                                if (!combinedResults.nodes.has(nodeKey)) {
                                    combinedResults.nodes.set(nodeKey, { ...node, dmqr_sources: [] });
                                }
                                if (enable_dmqr && result.metadata?.dmqrSource) {
                                    combinedResults.nodes.get(nodeKey).dmqr_sources.push(result.metadata.dmqrSource);
                                }
                            });
                        }
                        if (result.results.relations) {
                            result.results.relations.forEach((rel: any) => {
                                const relKey = `${rel.from}->${rel.to}::${rel.relationType}`;
                                if (!combinedResults.relations.has(relKey)) {
                                    combinedResults.relations.set(relKey, { ...rel, dmqr_sources: [] });
                                }
                                if (enable_dmqr && result.metadata?.dmqrSource) {
                                    combinedResults.relations.get(relKey).dmqr_sources.push(result.metadata.dmqrSource);
                                }
                            });
                        }
                    }
                });

                // Fallback: If no results from Gemini translation, try direct search
                if (!hasResults) {
                    console.log(`[kg_nl_query] No results from Gemini translation, trying fallback search for query: "${query}"`);
                    try {
                        // Extract keywords from the query
                        const keywords = query.toLowerCase().match(/\b\w+\b/g) || [];
                        const searchTerms = keywords.filter((k: string) => k.length > 2); // Filter out short words

                        let fallbackResults: { nodes: GraphTraversalNode[], relations: any[] } = { nodes: [], relations: [] };

                        for (const term of searchTerms) {
                            const searchResult = await memoryManager.knowledgeGraphManager.searchNodes(agent_id, term);
                            if (searchResult && searchResult.length > 0) {
                                fallbackResults.nodes.push(...searchResult);
                            }
                        }

                        // Remove duplicates
                        const uniqueNodes = Array.from(new Map(fallbackResults.nodes.map((n: GraphTraversalNode) => [n.node_id, n])).values());

                        if (uniqueNodes.length > 0) {
                            hasResults = true;
                            combinedResults.nodes = new Map(uniqueNodes.map((n: GraphTraversalNode) => [`${n.name}::${n.entityType}`, n]));
                            combinedResults.metadata = {
                                translatedOperation: 'search_nodes',
                                translatedArgs: { query: searchTerms.join(' ') },
                                usedGemini: false,
                                fallback: true
                            };
                        }
                    } catch (fallbackError) {
                        console.warn(`[kg_nl_query] Fallback search failed:`, fallbackError);
                    }
                }

                // Format metadata section
                if (combinedResults.metadata) {
                    md += `### Query Translation
`;
                    md += `- **Operation:** \`${combinedResults.metadata.translatedOperation || 'N/A'}\`
`;
                    if (combinedResults.metadata.translatedArgs) {
                        md += `- **Arguments:**
${formatJsonToMarkdownCodeBlock(combinedResults.metadata.translatedArgs)}
`;
                    }
                    if (combinedResults.metadata.assumptions) md += `- **Assumptions:** ${combinedResults.metadata.assumptions}
`;
                    md += `- **Used Gemini for Translation:** ${combinedResults.metadata.usedGemini ? 'Yes' : 'No'}
`;
                } else {
                    md += `*Query translation metadata not available.*
`;
                }

                md += `### Results
`;

                if (!hasResults) {
                    md += `*No results found matching the query.*
`;
                } else {
                    const finalResults = {
                        nodes: Array.from(combinedResults.nodes.values()),
                        relations: Array.from(combinedResults.relations.values())
                    };
                    
                    if (enable_dmqr) {
                        md += `**Combined Results from ${queryMetrics.totalQueries} DMQR queries:**
`;
                    }
                    
                    md += formatJsonToMarkdownCodeBlock(finalResults);
                }

                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                console.error(`Error in kg_nl_query tool (agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Natural language query failed: ${error.message}`);
            }
        },

        'kg_infer_relations': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for kg_infer_relations.");
            }

            try {
                const result = await memoryManager.knowledgeGraphManager.inferRelations(agent_id, args.entity_names, args.context);

                let md = `## Relation Inference Result for Agent: \`${agent_id}\`
`;

                if (args.entity_names && args.entity_names.length > 0) md += `**Focused Entities:** ${args.entity_names.map((e: string) => `\`${e}\``).join(', ')}
`;
                if (args.context) md += `**Additional Context:** ${args.context}
`;

                md += `
**Status:** ${result.message}
`;

                if (result.details && result.details.length > 0) {
                    md += `### Proposed/Added Relations:
`;
                    md += `| From | To | Relation Type | Confidence | Evidence | Status |
`;
                    md += `|------|----|---------------|------------|----------|--------|
`;

                    result.details.forEach((rel: any) => {
                        const confidence = rel.confidence ? `${(rel.confidence * 100).toFixed(0)}%` : 'N/A';
                        const evidence = rel.evidence || 'No specific evidence provided';
                        const status = rel.status || 'proposed_by_ai';
                        const statusEmoji = status.startsWith('added') ? '✅' : status.startsWith('failed') ? '❌' : '🔍';

                        md += `| \`${rel.from}\` | \`${rel.to}\` | \`${rel.relationType}\` | ${confidence} | ${evidence.substring(0, 50)}${evidence.length > 50 ? '...' : ''} | ${statusEmoji} ${status} |
`;
                    });

                    md += `
### Legend:
`;
                    md += `- ✅ **added_by_ai**: High-confidence relation automatically added.
`;
                    md += `- 🔍 **proposed_by_ai**: Relation proposed by AI, requires review.
`;
                    md += `- ❌ **failed**: Relation could not be added.
`;
                } else {
                    md += `*No new relations were inferred or added.*
`;
                }

                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                console.error(`Error in kg_infer_relations tool (agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Relation inference failed: ${error.message}`);
            }
        },

        'kg_visualize': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for kg_visualize.");
            }

            try {
                let mermaidGraph: string;
                let md = `## Knowledge Graph Visualization for Agent: \`${agent_id}\`
`;

                if (args.natural_language_query) {
                    md += `**Based on Natural Language Query:** "${args.natural_language_query}"
`;

                    const visualizationOptions = {
                        query: args.query,
                        natural_language_query: args.natural_language_query,
                        layoutDirection: args.layout_direction || 'TD',
                        depth: args.depth || 2,
                        includeLegend: args.include_legend !== false,
                        groupByDirectory: args.group_by_directory || false,
                        maxNodes: args.max_nodes,
                        maxEdges: args.max_edges,
                        excludeImports: args.exclude_imports,
                        excludeRelationTypes: args.exclude_relation_types
                    };

                    mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(
                        agent_id,
                        visualizationOptions
                    );
                } else {
                    if (args.query) md += `**Based on Direct Query:** "${args.query}"
`;

                    const visualizationOptions = {
                        query: args.query,
                        layoutDirection: args.layout_direction || 'TD',
                        depth: args.depth || 2,
                        includeLegend: args.include_legend !== false,
                        groupByDirectory: args.group_by_directory || false,
                        maxNodes: args.max_nodes,
                        maxEdges: args.max_edges,
                        excludeImports: args.exclude_imports,
                        excludeRelationTypes: args.exclude_relation_types
                    };

                    mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(
                        agent_id,
                        visualizationOptions
                    );
                }

                if (args.layout_direction && args.layout_direction !== 'TD') md += `**Layout:** ${args.layout_direction}
`;
                if (args.group_by_directory) md += `**Grouping:** By directory
`;

                md += `
\`\`\`mermaid
${mermaidGraph}
\`\`\`
`;

                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                console.error(`Error in kg_visualize tool (agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Knowledge graph visualization failed: ${error.message}`);
            }
        },
    };
}