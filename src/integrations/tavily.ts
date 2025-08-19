import axios from 'axios'; // Import axios
import { MemoryManager } from '../database/memory_manager.js';

export interface WebSearchResult {
    title: string;
    url: string;
    content: string;
}

const TAVILY_MOCK_MODE = process.env.TAVILY_MOCK_MODE === 'true';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'; // Define endpoint
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
    }
) {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    if (TAVILY_MOCK_MODE) {
        console.log('Tavily Mock Mode: Returning mock search results.');
        return [
            {
                title: `Mock Result for "${query}"`,
                url: `https://mock.example.com/search?q=${encodeURIComponent(query)}`,
                content: `This is mock content for the search query: "${query}". In a real scenario, this would be actual search data.`
            },
            {
                title: `Another Mock Result for "${query}"`,
                url: `https://mock.example.com/another?q=${encodeURIComponent(query)}`,
                content: `More mock data related to: "${query}".`
            }
        ];
    }
    if (!TAVILY_API_KEY) {
        console.warn('TAVILY_API_KEY environment variable is not set. Tavily search will not be available.');
        throw new Error('Tavily API key is not configured. Cannot perform search.');
    }
    try {
        // Removed debug console.logs
        const response = await axios.post(TAVILY_SEARCH_ENDPOINT, {
            api_key: TAVILY_API_KEY, // Explicitly pass API key in request body
            query: query,
            search_depth: options?.search_depth || 'basic',
            max_results: options?.max_results || 5,
            include_raw_content: options?.include_raw_content || false,
            include_images: options?.include_images || false,
            include_image_descriptions: options?.include_image_descriptions || false,
            time_period: options?.time_period,
            topic: options?.topic
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        return response.data.results; // Access data.results as per Tavily API response
    } catch (error: any) {
        if (axios.isAxiosError(error) && error.response) {
            throw new Error(`Failed to call Tavily API: ${error.response.status} Error: ${JSON.stringify(error.response.data)}`);
        }
        throw new Error(`Failed to call Tavily API: ${error.message}`);
    }
}