import { execa } from 'execa';
import type { ResultPromise } from 'execa';

type ExecaChildProcess = ResultPromise;
import readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import crypto from 'crypto';
import { CrossPlatformClaudeCode } from '../../../utils/CrossPlatformClaudeCode.js';

// Claude Code message types (from kilocode implementation)
interface InitMessage {
    type: "system";
    subtype: "init";
    session_id: string;
    tools: string[];
    mcp_servers: string[];
    apiKeySource: "none" | "/login managed key" | string;
}

interface AssistantMessage {
    type: "assistant";
    message: {
        content: Array<{
            type: 'text' | 'thinking' | 'redacted_thinking';
            text?: string;
            thinking?: string;
        }>;
        stop_reason: string | null;
        usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };
    session_id: string;
}

interface ResultMessage {
    type: "result";
    subtype: "success";
    total_cost_usd: number;
    is_error: boolean;
    duration_ms: number;
    duration_api_ms: number;
    num_turns: number;
    result: string;
    session_id: string;
}

type ClaudeCodeMessage = InitMessage | AssistantMessage | ResultMessage;

// Configuration
const CLAUDE_CODE_INSTALLATION_URL = "https://docs.anthropic.com/en/docs/claude-code/setup";
const CLAUDE_CODE_TIMEOUT = 600000; // 10 minutes
const MAX_SYSTEM_PROMPT_LENGTH = 65536;

// Disable built-in tools to use our custom tool format
const CLAUDE_CODE_DISABLED_TOOLS = [
    "Task", "Bash", "Glob", "Grep", "LS", "exit_plan_mode",
    "Read", "Edit", "MultiEdit", "Write", "NotebookRead",
    "NotebookEdit", "WebFetch", "TodoRead", "TodoWrite", "WebSearch"
].join(",");

export interface ClaudeCodeOptions {
    systemPrompt: string;
    messages: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    modelId?: string;
    maxOutputTokens?: number;
    claudePath?: string;
    useVertex?: boolean;
}

export interface ClaudeCodeResponse {
    content: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        totalCost?: number;
    };
    isSubscriber: boolean;
    sessionId: string;
    executionTime: number;
}

export class ClaudeCodeClient {
    private claudePath: string;
    private readonly defaultMaxOutputTokens = 16000;
    private crossPlatformHelper: CrossPlatformClaudeCode;

    constructor(claudePath?: string) {
        this.crossPlatformHelper = CrossPlatformClaudeCode.getInstance();
        this.claudePath = claudePath || "claude"; // Will be resolved during initialization
    }

    /**
     * Generate temporary system prompt file for Windows or long prompts
     */
    private async generateTempSystemPrompt(systemPrompt: string): Promise<string | undefined> {
        const isWindows = os.platform() === "win32";
        const isSystemPromptTooLong = systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH;

        if (!isWindows && !isSystemPromptTooLong) {
            return undefined;
        }

        const uniqueId = crypto.randomUUID();
        const tempFilePath = path.join(os.tmpdir(), `orchestrator-claude-prompt-${uniqueId}.txt`);
        await fs.writeFile(tempFilePath, systemPrompt, "utf8");
        return tempFilePath;
    }

    /**
     * Clean up temporary system prompt file
     */
    private async unlinkTempSystemPrompt(systemPromptFile: string | undefined): Promise<void> {
        if (!systemPromptFile) return;
        await fs.unlink(systemPromptFile).catch(console.warn);
    }

    /**
     * Create Claude Code process
     */
    private createProcess(options: ClaudeCodeOptions, systemPromptFile?: string): ResultPromise {
        const args = ["-p"];

        // System prompt handling
        if (systemPromptFile) {
            args.push("--system-prompt-file", systemPromptFile);
        } else {
            args.push("--system-prompt", options.systemPrompt);
        }

        // Configuration
        args.push(
            "--verbose",
            "--output-format", "stream-json",
            "--disallowedTools", CLAUDE_CODE_DISABLED_TOOLS,
            "--max-turns", "1" // Let orchestrator handle multi-turn conversations
        );

        // Model selection
        if (options.modelId) {
            const modelId = options.useVertex ?
                this.convertModelNameForVertex(options.modelId) :
                options.modelId;
            args.push("--model", modelId);
        }

        const child = execa(this.claudePath, args, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                CLAUDE_CODE_MAX_OUTPUT_TOKENS: (
                    options.maxOutputTokens ||
                    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ||
                    this.defaultMaxOutputTokens
                ).toString(),
            },
            maxBuffer: 1024 * 1024 * 1000,
            timeout: CLAUDE_CODE_TIMEOUT,
        });

        return child;
    }

    /**
     * Convert model name for Vertex AI format
     */
    private convertModelNameForVertex(modelName: string): string {
        const VERTEX_DATE_PATTERN = /-(\d{8})$/;
        return modelName.replace(VERTEX_DATE_PATTERN, "@$1");
    }

    /**
     * Parse Claude Code streaming output
     */
    private parseChunk(data: string, partialData: string | null): { chunk: ClaudeCodeMessage | null; newPartialData: string | null } {
        let fullData = partialData ? partialData + data : data;

        try {
            const parsed = JSON.parse(fullData);
            return { chunk: parsed, newPartialData: null };
        } catch {
            // Incomplete JSON, store for next chunk
            return { chunk: null, newPartialData: fullData };
        }
    }

    /**
     * Execute Claude Code request
     */
    async executeRequest(options: ClaudeCodeOptions): Promise<ClaudeCodeResponse> {
        const startTime = Date.now();
        const systemPromptFile = await this.generateTempSystemPrompt(options.systemPrompt);
        let process: ExecaChildProcess | null = null;

        try {
            process = this.createProcess(options, systemPromptFile);
        } catch (error: any) {
            if (error.code === "ENOENT" || error.message?.includes("ENOENT")) {
                throw this.createClaudeCodeNotFoundError(error);
            }
            throw error;
        }

        if (!process.stdout) {
            throw new Error('Process stdout not available');
        }

        const rl = readline.createInterface({
            input: process.stdout as any,
        });

        try {
            let isSubscriber = false;
            let sessionId = "";
            let responseContent = "";
            let usage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalCost: 0,
            };

            let partialData: string | null = null;
            let processError: Error | null = null;
            let stderrLogs = "";

            // Handle process events
            process.stderr?.on("data", (data: any) => {
                stderrLogs += data.toString();
            });

            process.on("error", (err: any) => {
                if (err.message.includes("ENOENT") || (err as any).code === "ENOENT") {
                    processError = this.createClaudeCodeNotFoundError(err);
                } else {
                    processError = err;
                }
                rl.close();
            });

            // Send messages to Claude Code
            const stdinData = JSON.stringify(options.messages);
            setImmediate(() => {
                try {
                    if (process.stdin) {
                        process.stdin.write(stdinData, "utf8", (error: any) => {
                            if (error) {
                                console.error("Error writing to Claude Code stdin:", error);
                                process.kill();
                            }
                        });
                        process.stdin.end();
                    }
                } catch (error) {
                    console.error("Error accessing Claude Code stdin:", error);
                    process.kill();
                }
            });

            // Process streaming output
            for await (const line of rl) {
                if (processError) {
                    throw processError;
                }

                if (!line.trim()) continue;

                const { chunk, newPartialData } = this.parseChunk(line, partialData);
                partialData = newPartialData;

                if (!chunk) continue;

                // Handle different message types
                if (chunk.type === "system" && "subtype" in chunk && chunk.subtype === "init") {
                    const initMsg = chunk as InitMessage;
                    sessionId = initMsg.session_id;
                    isSubscriber = initMsg.apiKeySource === "none";
                    console.log(`[ClaudeCode] Session ${sessionId} - ${isSubscriber ? 'Subscriber' : 'API User'}`);
                    continue;
                }

                if (chunk.type === "assistant" && "message" in chunk) {
                    const assistantMsg = chunk as AssistantMessage;
                    const message = assistantMsg.message;

                    // Check for API errors
                    if (message.stop_reason !== null) {
                        const textContent = message.content.find(c => c.type === 'text' && c.text);
                        if (textContent?.text?.startsWith("API Error")) {
                            const errorStart = textContent.text.indexOf("{");
                            const errorMessage = textContent.text.slice(errorStart);
                            throw new Error(`Claude Code API Error: ${errorMessage}`);
                        }
                    }

                    // Extract content (filter out thinking blocks)
                    for (const content of message.content) {
                        if (content.type === "text" && content.text) {
                            responseContent += content.text;
                        }
                        // Note: thinking blocks are available but not included in response
                    }

                    // Accumulate usage
                    usage.inputTokens += message.usage.input_tokens;
                    usage.outputTokens += message.usage.output_tokens;
                    usage.cacheReadTokens += message.usage.cache_read_input_tokens || 0;
                    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens || 0;
                    continue;
                }

                if (chunk.type === "result" && "result" in chunk) {
                    const resultMsg = chunk as ResultMessage;
                    usage.totalCost = isSubscriber ? 0 : resultMsg.total_cost_usd;
                    console.log(`[ClaudeCode] Completed in ${resultMsg.duration_ms}ms`);
                    break;
                }
            }

            // Handle any remaining partial data
            if (partialData && partialData.startsWith(`{"type":"assistant"`)) {
                const { chunk } = this.parseChunk("", partialData);
                if (chunk && chunk.type === "assistant" && "message" in chunk) {
                    const assistantMsg = chunk as AssistantMessage;
                    for (const content of assistantMsg.message.content) {
                        if (content.type === "text" && content.text) {
                            responseContent += content.text;
                        }
                    }
                }
            }

            const { exitCode } = await process;
            if (exitCode !== null && exitCode !== 0) {
                throw new Error(
                    `Claude Code process exited with code ${exitCode}.${stderrLogs ? ` Error: ${stderrLogs.trim()}` : ""}`
                );
            }

            return {
                content: responseContent || "No response generated",
                usage,
                isSubscriber,
                sessionId,
                executionTime: Date.now() - startTime,
            };

        } finally {
            rl.close();
            if (process && !process.killed) {
                process.kill();
            }
            await this.unlinkTempSystemPrompt(systemPromptFile);
        }
    }

    /**
     * Create user-friendly error for missing Claude Code CLI
     */
    private createClaudeCodeNotFoundError(originalError: Error): Error {
        const platformConfig = this.crossPlatformHelper.getPlatformConfig();

        const errorMessage = `
Claude Code CLI not found at "${this.claudePath}".

${platformConfig.setupInstructions}

Platform: ${platformConfig.platform}
Checked paths: ${platformConfig.possiblePaths.length} locations

Original error: ${originalError.message}
        `.trim();

        const error = new Error(errorMessage);
        error.name = "ClaudeCodeNotFoundError";
        return error;
    }

    /**
     * Test if Claude Code CLI is available with cross-platform detection
     */
    async testConnection(): Promise<{
        available: boolean;
        version?: string;
        error?: string;
        path?: string;
        platformInfo?: any;
    }> {
        try {
            // First try to detect Claude Code using cross-platform helper
            const detection = await this.crossPlatformHelper.detectClaudeCode(
                this.claudePath !== "claude" ? this.claudePath : undefined
            );

            if (detection.found && detection.path) {
                // Update our claudePath to the detected one
                this.claudePath = detection.path;

                return {
                    available: true,
                    version: detection.version,
                    path: detection.path,
                    platformInfo: {
                        platform: this.crossPlatformHelper.getPlatformConfig().platform,
                        installationMethod: detection.installationMethod,
                        pathsChecked: this.crossPlatformHelper.getDebugInfo().possiblePaths.length
                    }
                };
            } else {
                // Fallback to original method
                const result = await execa(this.claudePath, ["--version"], { timeout: 15000 });
                return {
                    available: true,
                    version: result.stdout.trim(),
                    path: this.claudePath
                };
            }
        } catch (error: any) {
            const debugInfo = this.crossPlatformHelper.getDebugInfo();
            return {
                available: false,
                error: error.message,
                platformInfo: {
                    platform: debugInfo.platform,
                    pathsChecked: debugInfo.possiblePaths.length,
                    possiblePaths: debugInfo.possiblePaths
                }
            };
        }
    }

    /**
     * Get optimal Claude Code path for current platform
     */
    async getOptimalPath(): Promise<string> {
        return await this.crossPlatformHelper.getOptimalClaudeCodePath();
    }

    /**
     * Get platform-specific setup information
     */
    async getSetupInfo(): Promise<{
        detection: any;
        platformConfig: any;
        recommendations: string[];
    }> {
        return await this.crossPlatformHelper.getSetupInfo();
    }

    /**
     * Test Claude Code installation with detailed diagnostics
     */
    async testInstallation(): Promise<{
        success: boolean;
        path?: string;
        version?: string;
        error?: string;
        performance?: {
            detectionTime: number;
            versionCheckTime: number;
        };
    }> {
        return await this.crossPlatformHelper.testClaudeCodeInstallation(
            this.claudePath !== "claude" ? this.claudePath : undefined
        );
    }
}