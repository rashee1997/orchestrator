import { MemoryManager } from '../database/memory_manager.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { jest } from '@jest/globals'; // Import jest explicitly

// Mock the GoogleGenAI module to control Gemini API responses
jest.mock('@google/genai', () => {
  const mockGenerateContent = jest.fn(async ({ contents }) => {
    const prompt = contents[0].parts[0].text;
    // This condition is for the test case that explicitly unsets the API key
    // and expects an error message from processAndRefinePrompt itself.
    // The mock should not throw an error here, but rather return the error structure.
    if (process.env.GEMINI_API_KEY === undefined || process.env.GEMINI_API_KEY === null) {
        return {
            text: JSON.stringify({ // Directly return the string
                refined_prompt_id: randomUUID(),
                original_prompt_text: "test raw prompt",
                refinement_engine_model: "gemini-2.0-flash",
                refinement_timestamp: new Date().toISOString(),
                overall_goal: "Error: Gemini API key not configured.",
                decomposed_tasks: [],
                key_entities_identified: [],
                implicit_assumptions_made_by_refiner: [],
                explicit_constraints_from_prompt: [],
                suggested_ai_role_for_agent: null,
                suggested_reasoning_strategy_for_agent: null,
                desired_output_characteristics_inferred: {},
                suggested_context_analysis_for_agent: [],
                confidence_in_refinement_score: "Low",
                refinement_error_message: "Gemini API key is not configured. Cannot perform prompt refinement."
            }),
        };
    }

    // Simulate a successful Gemini response for valid API key scenarios
    return {
      text: JSON.stringify({ // Directly return the string
        refined_prompt_id: randomUUID(),
        original_prompt_text: "test raw prompt",
        refinement_engine_model: "gemini-2.0-flash",
        refinement_timestamp: new Date().toISOString(),
        overall_goal: "Refine the test prompt.",
        decomposed_tasks: ["Analyze the prompt.", "Generate suggestions."],
        key_entities_identified: ["test prompt", "Gemini API"],
        implicit_assumptions_made_by_refiner: ["User wants a structured output."],
        explicit_constraints_from_prompt: ["Output must be JSON."],
        suggested_ai_role_for_agent: "Test Refiner",
        suggested_reasoning_strategy_for_agent: "Follow test plan.",
        desired_output_characteristics_inferred: {
          type: "JSON Object",
          key_content_elements: ["refined_prompt_id", "overall_goal"],
          level_of_detail: "High"
        },
        suggested_context_analysis_for_agent: [
          {
            suggestion_type: "MEMORY_RETRIEVAL",
            tool_to_use: "get_conversation_history",
            parameters: {"limit": 1},
            rationale: "Test rationale."
          }
        ],
        confidence_in_refinement_score: "High",
        refinement_error_message: null
      }, null, 2),
    };
  });

  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent,
      },
    })),
    createUserContent: jest.fn(),
    createPartFromUri: jest.fn(),
  };
});

describe('Prompt Refinement Tool', () => {
  let memoryManager: MemoryManager;
  let mcpServer: any; // Using 'any' for simplicity due to complex MCP server setup

  beforeAll(async () => {
    // Temporarily set a dummy API key for tests that expect it
    process.env.GEMINI_API_KEY = 'dummy-api-key';

    // Create a mock GoogleGenAI instance
    const MockGoogleGenAI = jest.fn().mockImplementation(() => ({
      models: {
        generateContent: jest.fn(async ({ contents }) => {
          // This mock logic is now simpler as the MemoryManager handles the API key check
          return {
            text: JSON.stringify({ // Directly return the string
              refined_prompt_id: randomUUID(),
              original_prompt_text: "test raw prompt",
              refinement_engine_model: "gemini-2.0-flash",
              refinement_timestamp: new Date().toISOString(),
              overall_goal: "Refine the test prompt.",
              decomposed_tasks: ["Analyze the prompt.", "Generate suggestions."],
              key_entities_identified: ["test prompt", "Gemini API"],
              implicit_assumptions_made_made_by_refiner: ["User wants a structured output."],
              explicit_constraints_from_prompt: ["Output must be JSON."],
              suggested_ai_role_for_agent: "Test Refiner",
              suggested_reasoning_strategy_for_agent: "Follow test plan.",
              desired_output_characteristics_inferred: {
                type: "JSON Object",
                key_content_elements: ["refined_prompt_id", "overall_goal"],
                level_of_detail: "High"
              },
              suggested_context_analysis_for_agent: [
                {
                  suggestion_type: "MEMORY_RETRIEVAL",
                  tool_to_use: "get_conversation_history",
                  parameters: {"limit": 1},
                  rationale: "Test rationale."
                }
              ],
              confidence_in_refinement_score: "High",
              refinement_error_message: null
            }, null, 2),
          };
        }),
      },
    }));
    const mockGenAIInstance = new MockGoogleGenAI();

    memoryManager = await MemoryManager.create(); // Initialize without passing mock instance

    // Mock the Server's internal methods to avoid actual stdio transport
    // and directly call the request handlers.
    mcpServer = {
      server: {
        setRequestHandler: jest.fn(),
        connect: jest.fn(),
        close: jest.fn(),
        onerror: jest.fn(),
      },
      memoryManager: memoryManager,
      setupToolHandlers: jest.fn(),
      run: jest.fn(),
    };

    // Manually set up the request handlers as they would be in index.ts
    // This requires copying the logic from index.ts's setupToolHandlers
    mcpServer.server.setRequestHandler.mockImplementation((schema: any, handler: any) => {
      if (schema === ListToolsRequestSchema) {
        mcpServer.listToolsHandler = handler;
      } else if (schema === CallToolRequestSchema) {
        mcpServer.callToolHandler = handler;
      }
    });

    // Simulate the setupToolHandlers call from index.ts
    // This is a simplified version, only including relevant parts for this test
    mcpServer.setupToolHandlers = () => {
        mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'refine_user_prompt',
                    description: 'Analyzes a raw user prompt using an LLM and returns a structured, refined version for AI agent processing, including suggestions for context analysis.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: "Identifier of the AI agent (e.g., 'cline')." },
                            raw_user_prompt: { type: 'string', description: "The raw text prompt received from the user." },
                            target_ai_persona: {
                              type: ['string', 'null'],
                              description: "Optional: A suggested persona for the AI agent to adopt for the task (e.g., 'expert Python developer', 'technical writer'). This helps the refiner tailor the output.",
                              default: null
                            },
                            conversation_context_ids: {
                              type: ['array', 'null'],
                              items: { type: 'string' },
                              description: "Optional: Array of recent conversation_ids or context_ids that might provide immediate context for the refinement, if available to the agent.",
                              default: null
                            }
                          },
                          required: ['agent_id', 'raw_user_prompt']
                    }
                }
            ]
        }));

        mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
            const { name, arguments: args } = request.params;
            if (name === 'refine_user_prompt') {
                const refinedPromptObject = await memoryManager.processAndRefinePrompt(
                    args.agent_id as string,
                    args.raw_user_prompt as string,
                    args.target_ai_persona as string | undefined,
                    args.conversation_context_ids as string[] | undefined
                );
                return { content: [{ type: 'text', text: JSON.stringify(refinedPromptObject, null, 2) }] };
            }
            throw new Error(`Unknown tool: ${name}`);
        });
    };
    mcpServer.setupToolHandlers(); // Call the setup
  });

  afterAll(async () => {
    // Clean up dummy API key
    delete process.env.GEMINI_API_KEY;
  });

  it('should refine a user prompt and return a structured JSON object', async () => {
    const agentId = 'test-agent-1';
    const rawPrompt = 'Create a simple web page with a button.';

    const request = {
      params: {
        name: 'refine_user_prompt',
        arguments: {
          agent_id: agentId,
          raw_user_prompt: rawPrompt,
        },
      },
    };

    const response = await mcpServer.callToolHandler(request);
    const parsedContent = JSON.parse(response.content[0].text);

    expect(parsedContent).toHaveProperty('refined_prompt_id');
    expect(parsedContent).toHaveProperty('original_prompt_text', rawPrompt);
    expect(parsedContent).toHaveProperty('overall_goal');
    expect(parsedContent.decomposed_tasks).toBeInstanceOf(Array);
    expect(parsedContent.suggested_context_analysis_for_agent).toBeInstanceOf(Array);
    expect(parsedContent.refinement_error_message).toBeNull();
  });

  it('should handle missing Gemini API key gracefully', async () => {
    // Temporarily unset the API key for this test
    const originalApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // Create a new MemoryManager instance *without* passing a genAI instance
    // This forces it to check process.env.GEMINI_API_KEY
    const localMemoryManager = await MemoryManager.create();

    const agentId = 'test-agent-2';
    const rawPrompt = 'Another test prompt.';

    // Directly call the method on the new localMemoryManager instance
    const refinedPromptObject = await localMemoryManager.processAndRefinePrompt(
        agentId,
        rawPrompt
    );

    expect(refinedPromptObject).toHaveProperty('refinement_error_message');
    expect(refinedPromptObject.refinement_error_message).toContain('Gemini API not initialized. Ensure GEMINI_API_KEY is set.');

    // Restore the API key
    process.env.GEMINI_API_KEY = originalApiKey;
  });

  it('should store a refined prompt in the database', async () => {
    const refinedPromptData = {
      refined_prompt_id: randomUUID(),
      agent_id: 'test-agent-3',
      original_prompt_text: 'Test prompt for storage.',
      refinement_engine_model: 'gemini-2.0-flash',
      refinement_timestamp: new Date().toISOString(),
      overall_goal: 'Store this prompt.',
      decomposed_tasks: ['Task A', 'Task B'],
      key_entities_identified: ['Entity X', 'Entity Y'],
      implicit_assumptions_made_by_refiner: ['Assumption 1'],
      explicit_constraints_from_prompt: ['Constraint 1'],
      suggested_ai_role_for_agent: 'Storage Agent',
      suggested_reasoning_strategy_for_agent: 'Store it well.',
      desired_output_characteristics_inferred: { type: 'Stored Data' },
      suggested_context_analysis_for_agent: [{ suggestion_type: 'NONE' }],
      confidence_in_refinement_score: 'High',
      refinement_error_message: null
    };

    const storedId = await memoryManager.storeRefinedPrompt(refinedPromptData);
    expect(storedId).toBe(refinedPromptData.refined_prompt_id);

    // Verify it can be retrieved
    const retrievedPrompt = await memoryManager.getRefinedPrompt(refinedPromptData.agent_id, storedId);
    expect(retrievedPrompt).toBeDefined();
    expect(retrievedPrompt.refined_prompt_id).toBe(refinedPromptData.refined_prompt_id);
    expect(retrievedPrompt.original_prompt_text).toBe(refinedPromptData.original_prompt_text);
    expect(retrievedPrompt.decomposed_tasks).toEqual(refinedPromptData.decomposed_tasks);
    expect(retrievedPrompt.key_entities_identified).toEqual(refinedPromptData.key_entities_identified);
  });

  it('should retrieve a refined prompt using the get_refined_prompt MCP tool', async () => {
    // First, generate and store a refined prompt using the refine_user_prompt tool
    const agentId = 'test-agent-4';
    const rawPrompt = 'Generate a report on climate change impacts.';

    const refineRequest = {
      params: {
        name: 'refine_user_prompt',
        arguments: {
          agent_id: agentId,
          raw_user_prompt: rawPrompt,
        },
      },
    };

    const refineResponse = await mcpServer.callToolHandler(refineRequest);
    const refinedPromptObject = JSON.parse(refineResponse.content[0].text);
    const refinedPromptId = refinedPromptObject.refined_prompt_id;

    expect(refinedPromptId).toBeDefined();

    // Now, use the get_refined_prompt tool to retrieve it
    const getRequest = {
      params: {
        name: 'get_refined_prompt',
        arguments: {
          agent_id: agentId, // Add agent_id to the request
          refined_prompt_id: refinedPromptId,
        },
      },
    };

    const getResponse = await mcpServer.callToolHandler(getRequest);
    const retrievedContent = JSON.parse(getResponse.content[0].text);

    expect(retrievedContent).toBeDefined();
    expect(retrievedContent.refined_prompt_id).toBe(refinedPromptId);
    expect(retrievedContent.original_prompt_text).toBe(rawPrompt);
    expect(retrievedContent.overall_goal).toBe(refinedPromptObject.overall_goal);
    expect(retrievedContent.decomposed_tasks).toEqual(refinedPromptObject.decomposed_tasks);
  });

  it('should return null or not found message for a non-existent refined prompt ID', async () => {
    const nonExistentId = randomUUID();
    const getRequest = {
      params: {
        name: 'get_refined_prompt',
        arguments: {
          agent_id: 'test-agent-1', // Assuming a default agent_id for this test case
          refined_prompt_id: nonExistentId,
        },
      },
    };

    const getResponse = await mcpServer.callToolHandler(getRequest);
    expect(getResponse.content[0].text).toContain(`Refined prompt with ID ${nonExistentId} not found for agent test-agent-1.`);
  });
});
