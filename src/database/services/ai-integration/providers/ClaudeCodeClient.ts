import { execa } from 'execa';
import type { ResultPromise } from 'execa';

type ExecaChildProcess = ResultPromise;
import readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import crypto from 'crypto';
import { CrossPlatformClaudeCode } from '../../../../utils/CrossPlatformClaudeCode.js';

// Claude Code message types (from kilocode implementation)
interface InitMessage {
    type: "system";
    subtype: "init";
    session_id: string;
    tools: string[];
    mcp_servers: string[];
    apiKeySource: string;
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
    private readonly crossPlatformHelper: CrossPlatformClaudeCode;

    constructor(claudePath: string = "claude") {
        this.crossPlatformHelper = CrossPlatformClaudeCode.getInstance();
        this.claudePath = claudePath;
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

    private isInitMessage(chunk: ClaudeCodeMessage): chunk is InitMessage {
        return chunk.type === "system" && "subtype" in chunk && chunk.subtype === "init";
    }

    private isAssistantMessage(chunk: ClaudeCodeMessage): chunk is AssistantMessage {
        return chunk.type === "assistant" && "message" in chunk;
    }

    private isResultMessage(chunk: ClaudeCodeMessage): chunk is ResultMessage {
        return chunk.type === "result" && "result" in chunk;
    }

    /**
     * Initialize streaming state variables
     */
    private initializeStreamingState() {
        return {
            isSubscriber: false,
            sessionId: "",
            responseContent: "",
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalCost: 0,
            },
            partialData: null as string | null,
            processError: null as Error | null,
            stderrLogs: "",
        };
    }

    /**
     * Set up process event handlers
     */
    private setupProcessEventHandlers(
        process: ExecaChildProcess,
        rl: readline.Interface,
        state: ReturnType<typeof this.initializeStreamingState>
    ): void {
        process.stderr?.on("data", (data: any) => {
            state.stderrLogs += data.toString();
        });

        process.on("error", (err: NodeJS.ErrnoException) => {
            if (err.message.includes("ENOENT") || err.code === "ENOENT") {
                state.processError = this.createClaudeCodeNotFoundError(err);
            } else {
                state.processError = err;
            }
            rl.close();
        });
    }

    /**
     * Send messages to Claude Code process
     */
    private sendMessagesToProcess(process: ExecaChildProcess, messages: any[]): void {
        const stdinData = JSON.stringify(messages);
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
    }

    /**
     * Process init message chunk
     */
    private processInitMessage(chunk: InitMessage, state: ReturnType<typeof this.initializeStreamingState>): void {
        state.sessionId = chunk.session_id;
        state.isSubscriber = chunk.apiKeySource === "none";
        console.log(`[ClaudeCode] Session ${state.sessionId} - ${state.isSubscriber ? 'Subscriber' : 'API User'}`);
    }

    /**
     * Process assistant message chunk
     */
    private processAssistantMessage(chunk: AssistantMessage, state: ReturnType<typeof this.initializeStreamingState>): void {
        const message = chunk.message;

        if (message.stop_reason !== null) {
            this.checkForApiError(message);
        }

        this.extractResponseContent(message, state);
        this.updateUsageStats(message, state);
    }

    /**
     * Check for API errors in assistant message
     */
    private checkForApiError(message: AssistantMessage['message']): void {
        const textContent = message.content.find(c => c.type === 'text' && c.text);
        if (!textContent?.text?.startsWith("API Error")) return;
        const text = textContent.text;

        const errorStart = text.indexOf("{");
        const errorMessage = text.slice(errorStart);
        throw new Error(`Claude Code API Error: ${errorMessage}`);
    }

    /**
     * Extract response content from assistant message
     */
    private extractResponseContent(message: AssistantMessage['message'], state: ReturnType<typeof this.initializeStreamingState>): void {
        for (const content of message.content) {
            if (content.type === "text" && content.text) {
                state.responseContent += content.text;
            }
        }
    }

    /**
     * Update usage statistics from assistant message
     */
    private updateUsageStats(message: AssistantMessage['message'], state: ReturnType<typeof this.initializeStreamingState>): void {
        state.usage.inputTokens += message.usage.input_tokens;
        state.usage.outputTokens += message.usage.output_tokens;
        state.usage.cacheReadTokens += message.usage.cache_read_input_tokens || 0;
        state.usage.cacheWriteTokens += message.usage.cache_creation_input_tokens || 0;
    }

    /**
     * Process result message chunk
     */
    private processResultMessage(chunk: ResultMessage, state: ReturnType<typeof this.initializeStreamingState>): void {
        state.usage.totalCost = state.isSubscriber ? 0 : chunk.total_cost_usd;
        console.log(`[ClaudeCode] Completed in ${chunk.duration_ms}ms`);
        throw new Error("COMPLETE");
    }

    /**
     * Process streaming chunk
     */
    private processStreamingChunk(
        chunk: ClaudeCodeMessage,
        state: ReturnType<typeof this.initializeStreamingState>
    ): void {
        if (this.isInitMessage(chunk)) {
            this.processInitMessage(chunk, state);
            return;
        }

        if (this.isAssistantMessage(chunk)) {
            this.processAssistantMessage(chunk, state);
            return;
        }

        if (this.isResultMessage(chunk)) {
            this.processResultMessage(chunk, state);
        }
    }

    /**
     * Handle remaining partial data
     */
    private handleRemainingPartialData(partialData: string | null, state: ReturnType<typeof this.initializeStreamingState>): void {
        if (partialData?.startsWith(`{"type":"assistant"`)) {
            const { chunk } = this.parseChunk("", partialData);
            if (chunk && this.isAssistantMessage(chunk)) {
                for (const content of chunk.message.content) {
                    if (content.type === "text" && content.text) {
                        state.responseContent += content.text;
                    }
                }
            }
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

        const state = this.initializeStreamingState();
        this.setupProcessEventHandlers(process, rl, state);
        this.sendMessagesToProcess(process, options.messages);

        try {
            await this.handleStreamingOutput(
                rl,
                (chunk, newPartialData) => {
                    state.partialData = newPartialData;
                    if (!chunk) return;
                    this.processStreamingChunk(chunk, state);
                },
                () => state.processError
            );

            this.handleRemainingPartialData(state.partialData, state);

            const { exitCode } = await process;
            if (exitCode !== null && exitCode !== 0) {
                const stderrInfo = state.stderrLogs ? ` Error: ${state.stderrLogs.trim()}` : "";
                throw new Error(`Claude Code process exited with code ${exitCode}.${stderrInfo}`);
            }

            return {
                content: state.responseContent || "No response generated",
                usage: state.usage,
                isSubscriber: state.isSubscriber,
                sessionId: state.sessionId,
                executionTime: Date.now() - startTime,
            };

        } catch (e) {
            if (e === "COMPLETE") {
                return {
                    content: state.responseContent || "No response generated",
                    usage: state.usage,
                    isSubscriber: state.isSubscriber,
                    sessionId: state.sessionId,
                    executionTime: Date.now() - startTime,
                };
            }
            throw e;
        } finally {
            rl.close();
            if (process !== null && !process.killed) {
                process.kill();
            }
            await this.unlinkTempSystemPrompt(systemPromptFile);
        }
    }

    /**
     * Helper to handle streaming output and reduce cognitive complexity
     */
    private async handleStreamingOutput(
        rl: readline.Interface,
        onChunk: (chunk: ClaudeCodeMessage | null, newPartialData: string | null) => void,
        getProcessError: () => Error | null
    ): Promise<void> {
        let partialData: string | null = null;
        for await (const line of rl) {
            const processError = getProcessError();
            if (processError) {
                throw processError;
            }
            if (!line.trim()) continue;
            const { chunk, newPartialData } = this.parseChunk(line, partialData);
            partialData = newPartialData;
            try {
                onChunk(chunk, partialData);
            } catch (e) {
                if (e === "COMPLETE") {
                    break;
                }
                throw e;
            }
        }
    }

    /**
     * Create user-friendly error for missing Claude Code CLI
     */
    private createClaudeCodeNotFoundError(originalError: Error): Error {
        const platformConfig = this.crossPlatformHelper.getPlatformConfig();
        const setupInstructions = platformConfig.setupInstructions;
        const platform = platformConfig.platform;
        const pathsCount = platformConfig.possiblePaths.length;
        const originalMessage = originalError.message;

        const errorMessage = [
            `Claude Code CLI not found at "${this.claudePath}".`,
            "",
            setupInstructions,
            "",
            `Platform: ${platform}`,
            `Checked paths: ${pathsCount} locations`,
            "",
            `Original error: ${originalMessage}`
        ].join("\n").trim();

        const error = new Error(errorMessage);
        error.name = "ClaudeCodeNotFoundError";
        return error;
    }

    /**
     * Test if Claude Code CLI is available
     */
    async testConnection(): Promise<{
        available: boolean;
        version?: string;
        error?: string;
        path?: string;
        platformInfo?: any;
    }> {
        try {
            const detection = await this.crossPlatformHelper.detectClaudeCode(
                this.claudePath !== "claude" ? this.claudePath : undefined
            );

            if (detection.found === true && detection.path) {
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
            }

            const result = await execa(this.claudePath, ["--version"], { timeout: 15000 });
            return {
                available: true,
                version: result.stdout.trim(),
                path: this.claudePath
            };
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
