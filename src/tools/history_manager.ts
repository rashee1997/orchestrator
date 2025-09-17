import { promises as fs } from 'fs';
import path from 'path';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { getCurrentModel } from '../database/services/gemini-integration-modules/GeminiConfig.js';

// Define the structure of our session and index
export interface ChatMessage {
    sender: 'user' | 'ai';
    content: string;
    timestamp: string;
    [key: string]: any; // Allow other properties like context, metrics, etc.
}

export interface ChatSession {
    sessionId: string; // The UUID for the file
    displayId: number; // The sequential, human-readable ID
    startTime: string;
    endTime: string | null;
    title: string;
    messages: ChatMessage[];
}

interface IndexEntry {
    title: string;
    filename: string;
    startTime: string;
    messageCount: number;
}

interface HistoryIndex {
    nextId: number;
    sessions: { [key: number]: IndexEntry };
    activeSessionFile: string | null;
}

export class HistoryManager {
    private historyDir: string;
    private indexPath: string;
    private geminiService: GeminiIntegrationService;

    constructor(projectRoot: string, geminiService: GeminiIntegrationService) {
        this.historyDir = path.join(projectRoot, 'history');
        this.indexPath = path.join(this.historyDir, 'index.json');
        this.geminiService = geminiService;
    }

    private async ensureHistoryDir(): Promise<void> {
        try {
            await fs.access(this.historyDir);
        } catch {
            await fs.mkdir(this.historyDir, { recursive: true });
        }
    }

    async loadIndex(): Promise<HistoryIndex> {
        await this.ensureHistoryDir();
        try {
            await fs.access(this.indexPath);
            const data = await fs.readFile(this.indexPath, 'utf-8');
            return JSON.parse(data) as HistoryIndex;
        } catch {
            // Return a default, empty index if it doesn't exist
            return { nextId: 1, sessions: {}, activeSessionFile: null };
        }
    }

    private async saveIndex(index: HistoryIndex): Promise<void> {
        await this.ensureHistoryDir();
        await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    }

    async loadSession(displayId: number): Promise<ChatSession | null> {
        const index = await this.loadIndex();
        const entry = index.sessions[displayId];
        if (!entry) {
            console.warn(`[HistoryManager] Session with display ID ${displayId} not found in index.`);
            return null;
        }

        try {
            const sessionPath = path.join(this.historyDir, entry.filename);
            const data = await fs.readFile(sessionPath, 'utf-8');
            return JSON.parse(data) as ChatSession;
        } catch (error) {
            console.error(`[HistoryManager] Failed to load session file ${entry.filename}:`, error);
            return null;
        }
    }

    async getLatestSession(): Promise<ChatSession | null> {
        const index = await this.loadIndex();
        const latestId = index.nextId - 1;
        if (latestId < 1) return null;
        return this.loadSession(latestId);
    }

    async saveActiveSession(session: ChatSession): Promise<void> {
        const index = await this.loadIndex();
        const filename = `${session.sessionId}.json`;
        const sessionPath = path.join(this.historyDir, filename);

        await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');

        index.activeSessionFile = filename;
        await this.saveIndex(index);
    }

    async loadActiveSession(): Promise<ChatSession | null> {
        const index = await this.loadIndex();
        if (!index.activeSessionFile) return null;

        try {
            const sessionPath = path.join(this.historyDir, index.activeSessionFile);
            const data = await fs.readFile(sessionPath, 'utf-8');
            return JSON.parse(data) as ChatSession;
        } catch (error) {
            // If the active session file is missing for some reason, clear it from the index.
            console.warn(`[HistoryManager] Active session file not found. Clearing from index.`);
            index.activeSessionFile = null;
            await this.saveIndex(index);
            return null;
        }
    }

    private async generateMeaningfulName(session: ChatSession): Promise<string> {
        if (!session.messages || session.messages.length === 0) {
            return 'empty_session';
        }

        const conversationForSummary = session.messages
            .slice(0, 4) // Use first few messages for a concise title
            .map(m => `${m.sender}: ${m.content.substring(0, 200)}...`)
            .join('\n');

        const prompt = `Based on the following conversation, generate a very concise, 4-6 word filename in lowercase snake_case. Example: 'refactoring_the_user_service'.\n\nConversation:\n${conversationForSummary}`;

        try {
            const result = await this.geminiService.askGemini(prompt, getCurrentModel());
            let name = result.content[0].text ?? 'untitled_session';
            // Clean up the name
            name = name.trim().toLowerCase();
            name = name.replace(/[^a-z0-9\s_]/g, ''); // Remove special characters
            name = name.replace(/\s+/g, '_'); // Replace spaces with underscores
            return name.substring(0, 100); // Limit length
        } catch (error) {
            console.error('[HistoryManager] Failed to generate meaningful name:', error);
            return `session_${session.displayId || 'untitled'}`;
        }
    }

    async finalizeActiveSession(): Promise<number | null> {
        const index = await this.loadIndex();
        const activeSession = await this.loadActiveSession();

        if (!activeSession) {
            return null;
        }

        // Don't finalize empty sessions
        if (activeSession.messages.length === 0) {
            const oldPath = path.join(this.historyDir, index.activeSessionFile!);
            await fs.unlink(oldPath); // Clean up empty file
            index.activeSessionFile = null;
            await this.saveIndex(index);
            return null;
        }

        const meaningfulName = await this.generateMeaningfulName(activeSession);
        const newId = index.nextId;
        activeSession.displayId = newId; // Assign the final sequential ID
        activeSession.endTime = new Date().toISOString();

        const finalFilename = `${newId}_${meaningfulName}.json`;
        const oldPath = path.join(this.historyDir, index.activeSessionFile!);
        const newPath = path.join(this.historyDir, finalFilename);

        // Update session content with final ID and save to new file
        await fs.writeFile(newPath, JSON.stringify(activeSession, null, 2), 'utf-8');

        // Delete the old temporary file
        await fs.unlink(oldPath);

        // Update the index
        index.sessions[newId] = {
            title: activeSession.title,
            filename: finalFilename,
            startTime: activeSession.startTime,
            messageCount: activeSession.messages.length,
        };
        index.nextId++;
        index.activeSessionFile = null;
        await this.saveIndex(index);

        console.log(`[HistoryManager] Finalized session. Saved as: ${finalFilename}`);
        return newId;
    }
}