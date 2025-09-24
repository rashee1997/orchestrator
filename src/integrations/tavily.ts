import axios from 'axios'; // Import axios
import { MemoryManager } from '../database/memory_manager.js';

export interface WebSearchResult {
    title: string;
    url: string;
    content: string;
    snippet?: string; // Enhanced: Add snippet for short descriptions
    published_date?: string; // Enhanced: Add publication date
    relevance_score?: number; // Enhanced: Add relevance scoring
}

export interface SearchMetadata {
    query: string;
    total_results: number;
    search_depth: 'basic' | 'advanced';
    processing_time_ms: number;
    filtered_results?: number;
}

const TAVILY_MOCK_MODE = process.env.TAVILY_MOCK_MODE === 'true';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'; // Define endpoint
const DEFAULT_TIMEOUT = 10000; // Enhanced: Add timeout configuration
const MAX_RETRIES = 3; // Enhanced: Add retry configuration

export async function callTavilyApi(
    query: string,
    options?: {
        search_depth?: 'basic' | 'advanced';
        max_results?: number;
        include_raw_content?: boolean;
        include_images?: boolean;
        include_image_descriptions?: boolean;
        time_period?: string;
        topic?: string;
        timeout?: number; // Enhanced: Configurable timeout
        filter_domains?: string[]; // Enhanced: Domain filtering
        exclude_domains?: string[]; // Enhanced: Domain exclusion
    }
): Promise<{ results: WebSearchResult[]; metadata: SearchMetadata }> {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    const startTime = Date.now(); // Enhanced: Track processing time

    if (TAVILY_MOCK_MODE) {
        console.log('Tavily Mock Mode: Returning enhanced mock search results.');
        const mockResults: WebSearchResult[] = [
            {
                title: `Mock Result for "${query}"`,
                url: `https://mock.example.com/search?q=${encodeURIComponent(query)}`,
                content: `This is mock content for the search query: "${query}". In a real scenario, this would be actual search data.`,
                snippet: `Mock snippet for ${query}`,
                published_date: new Date().toISOString(),
                relevance_score: 0.95
            },
            {
                title: `Another Mock Result for "${query}"`,
                url: `https://mock.example.com/another?q=${encodeURIComponent(query)}`,
                content: `More mock data related to: "${query}".`,
                snippet: `Additional mock content for ${query}`,
                published_date: new Date(Date.now() - 86400000).toISOString(), // Yesterday
                relevance_score: 0.87
            }
        ];

        return {
            results: mockResults,
            metadata: {
                query,
                total_results: mockResults.length,
                search_depth: options?.search_depth || 'basic',
                processing_time_ms: Date.now() - startTime
            }
        };
    }
    if (!TAVILY_API_KEY) {
        console.warn('TAVILY_API_KEY environment variable is not set. Tavily search will not be available.');
        throw new Error('Tavily API key is not configured. Cannot perform search.');
    }
    // Enhanced: Retry logic with exponential backoff
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`Calling Tavily API (attempt ${attempt}/${MAX_RETRIES}) for query: "${query}"`);

            const requestPayload = {
                api_key: TAVILY_API_KEY,
                query: query,
                search_depth: options?.search_depth || 'basic',
                max_results: options?.max_results || 5,
                include_raw_content: options?.include_raw_content || false,
                include_images: options?.include_images || false,
                include_image_descriptions: options?.include_image_descriptions || false,
                time_period: options?.time_period,
                topic: options?.topic,
                // Enhanced: Add new filtering options if provided
                ...(options?.filter_domains && { include_domains: options.filter_domains }),
                ...(options?.exclude_domains && { exclude_domains: options.exclude_domains })
            };

            const response = await axios.post(TAVILY_SEARCH_ENDPOINT, requestPayload, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: options?.timeout || DEFAULT_TIMEOUT
            });

            // Enhanced: Process and enrich results
            const rawResults = response.data.results || [];
            const enrichedResults: WebSearchResult[] = rawResults.map((result: any, index: number) => ({
                title: result.title || 'No title',
                url: result.url || '',
                content: result.content || result.raw_content || '',
                snippet: result.snippet || result.content?.substring(0, 200) + '...',
                published_date: result.published_date || result.date,
                relevance_score: result.score || (1 - index * 0.1) // Fallback scoring
            }));

            const metadata: SearchMetadata = {
                query,
                total_results: enrichedResults.length,
                search_depth: options?.search_depth || 'basic',
                processing_time_ms: Date.now() - startTime,
                filtered_results: rawResults.length !== enrichedResults.length ? enrichedResults.length : undefined
            };

            console.log(`Tavily API successful: ${enrichedResults.length} results in ${metadata.processing_time_ms}ms`);

            return {
                results: enrichedResults,
                metadata
            };

        } catch (error: any) {
            const isLastAttempt = attempt === MAX_RETRIES;

            if (axios.isAxiosError(error)) {
                const statusCode = error.response?.status;
                const errorData = error.response?.data;

                // Enhanced: Different handling for different error types
                if (statusCode === 429) { // Rate limited
                    if (!isLastAttempt) {
                        const backoffDelay = Math.pow(2, attempt) * 1000; // Exponential backoff
                        console.warn(`Rate limited, retrying in ${backoffDelay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, backoffDelay));
                        continue;
                    }
                } else if (statusCode && statusCode >= 500) { // Server error
                    if (!isLastAttempt) {
                        const backoffDelay = Math.pow(2, attempt) * 500;
                        console.warn(`Server error ${statusCode}, retrying in ${backoffDelay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, backoffDelay));
                        continue;
                    }
                }

                if (isLastAttempt) {
                    throw new Error(`Failed to call Tavily API after ${MAX_RETRIES} attempts: ${statusCode} Error: ${JSON.stringify(errorData)}`);
                }
            } else {
                if (isLastAttempt) {
                    throw new Error(`Failed to call Tavily API after ${MAX_RETRIES} attempts: ${error.message}`);
                }
            }

            // Wait before retry for non-rate-limit errors
            if (attempt < MAX_RETRIES) {
                const backoffDelay = Math.pow(2, attempt) * 300;
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
    }

    // This should never be reached due to the throw statements above
    throw new Error('Unexpected error in Tavily API retry logic');
}