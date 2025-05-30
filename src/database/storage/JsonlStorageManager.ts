// src/database/storage/JsonlStorageManager.ts
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import readline from 'readline';
import { fileURLToPath } from 'url';

export class JsonlStorageManager {
    private rootPath: string;

    constructor(rootPath?: string) {
        if (rootPath) {
            this.rootPath = rootPath;
        } else {
            // Get the directory of this file
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            // Navigate to the project root (3 levels up from src/database/storage/)
            const projectRoot = path.resolve(__dirname, '..', '..', '..');
            this.rootPath = path.join(projectRoot, 'knowledge_graphs');
        }
    }

    /**
     * Ensures the directory structure exists for a given agent
     */
    private async ensureDirectoryStructure(agentId: string): Promise<void> {
        const agentPath = path.join(this.rootPath, agentId);
        const dirs = [
            agentPath,
            path.join(agentPath, 'snapshots'),
            path.join(agentPath, 'indexes')
        ];

        for (const dir of dirs) {
            await fsp.mkdir(dir, { recursive: true });
        }
    }

    /**
     * Appends a line to a JSONL file
     */
    async appendLine(filePath: string, data: object): Promise<void> {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        const dir = path.dirname(absolutePath);
        
        // Ensure directory exists
        await fsp.mkdir(dir, { recursive: true });
        
        // Append the JSON line
        const jsonLine = JSON.stringify(data) + '\n';
        await fsp.appendFile(absolutePath, jsonLine, 'utf8');
    }

    /**
     * Reads lines from a JSONL file as an async generator
     */
    async *readLines(filePath: string): AsyncGenerator<any, void, unknown> {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        
        // Check if file exists
        try {
            await fsp.access(absolutePath);
        } catch {
            return; // File doesn't exist, return empty generator
        }

        const fileStream = createReadStream(absolutePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            if (line.trim()) {
                try {
                    yield JSON.parse(line);
                } catch (error) {
                    console.error(`Error parsing JSON line: ${line}`, error);
                    // Skip malformed lines
                }
            }
        }
    }

    /**
     * Reads all lines from a JSONL file into an array
     */
    async readAllLines(filePath: string): Promise<any[]> {
        const results: any[] = [];
        
        for await (const line of this.readLines(filePath)) {
            results.push(line);
        }
        
        return results;
    }

    /**
     * Creates a snapshot of the current state
     */
    async createSnapshot(agentId: string): Promise<string> {
        await this.ensureDirectoryStructure(agentId);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotPath = path.join(this.rootPath, agentId, 'snapshots', `${timestamp}.json`);
        
        // Read current state
        const nodes = await this.readAllLines(path.join(agentId, 'nodes.jsonl'));
        const relations = await this.readAllLines(path.join(agentId, 'relations.jsonl'));
        
        // Create snapshot object
        const snapshot = {
            timestamp: new Date().toISOString(),
            agentId,
            version: '1.0',
            data: {
                nodes,
                relations,
                nodeCount: nodes.length,
                relationCount: relations.length
            }
        };
        
        // Write snapshot
        await fsp.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
        
        return snapshotPath;
    }

    /**
     * Restores from a snapshot
     */
    async restoreFromSnapshot(agentId: string, timestamp: string): Promise<void> {
        const snapshotPath = path.join(this.rootPath, agentId, 'snapshots', `${timestamp}.json`);
        
        // Read snapshot
        const snapshotData = await fsp.readFile(snapshotPath, 'utf8');
        const snapshot = JSON.parse(snapshotData);
        
        // Backup current files
        const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const nodesPath = path.join(this.rootPath, agentId, 'nodes.jsonl');
        const relationsPath = path.join(this.rootPath, agentId, 'relations.jsonl');
        
        if (fs.existsSync(nodesPath)) {
            await fsp.rename(nodesPath, `${nodesPath}.backup-${backupTimestamp}`);
        }
        if (fs.existsSync(relationsPath)) {
            await fsp.rename(relationsPath, `${relationsPath}.backup-${backupTimestamp}`);
        }
        
        // Restore from snapshot
        for (const node of snapshot.data.nodes) {
            await this.appendLine(path.join(agentId, 'nodes.jsonl'), node);
        }
        
        for (const relation of snapshot.data.relations) {
            await this.appendLine(path.join(agentId, 'relations.jsonl'), relation);
        }
    }

    /**
     * Compacts a JSONL file by removing deleted entries and duplicates
     */
    async compact(filePath: string): Promise<void> {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        const tempPath = `${absolutePath}.tmp`;
        
        // Track latest version of each entity
        const latestEntities = new Map<string, any>();
        
        // Read all lines and keep only the latest version
        for await (const line of this.readLines(filePath)) {
            if (line.id) {
                // Skip deleted entries
                if (!line.deleted) {
                    latestEntities.set(line.id, line);
                } else {
                    latestEntities.delete(line.id);
                }
            }
        }
        
        // Write compacted data to temp file
        const writeStream = createWriteStream(tempPath);
        
        for (const entity of latestEntities.values()) {
            writeStream.write(JSON.stringify(entity) + '\n');
        }
        
        await new Promise((resolve, reject) => {
            writeStream.end((err: any) => {
                if (err) reject(err);
                else resolve(undefined);
            });
        });
        
        // Replace original file with compacted version
        await fsp.rename(tempPath, absolutePath);
    }

    /**
     * Gets metadata about a JSONL file
     */
    async getFileMetadata(filePath: string): Promise<{
        exists: boolean;
        size?: number;
        lineCount?: number;
        lastModified?: Date;
    }> {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        
        try {
            const stats = await fsp.stat(absolutePath);
            
            // Count lines
            let lineCount = 0;
            for await (const _ of this.readLines(filePath)) {
                lineCount++;
            }
            
            return {
                exists: true,
                size: stats.size,
                lineCount,
                lastModified: stats.mtime
            };
        } catch {
            return { exists: false };
        }
    }

    /**
     * Lists all snapshots for an agent
     */
    async listSnapshots(agentId: string): Promise<string[]> {
        const snapshotsPath = path.join(this.rootPath, agentId, 'snapshots');
        
        try {
            const files = await fsp.readdir(snapshotsPath);
            return files
                .filter(f => f.endsWith('.json'))
                .sort()
                .reverse(); // Most recent first
        } catch {
            return [];
        }
    }

    /**
     * Deletes old snapshots, keeping only the most recent N
     */
    async pruneSnapshots(agentId: string, keepCount: number = 10): Promise<number> {
        const snapshots = await this.listSnapshots(agentId);
        let deletedCount = 0;
        
        if (snapshots.length > keepCount) {
            const toDelete = snapshots.slice(keepCount);
            
            for (const snapshot of toDelete) {
                const snapshotPath = path.join(this.rootPath, agentId, 'snapshots', snapshot);
                await fsp.unlink(snapshotPath);
                deletedCount++;
            }
        }
        
        return deletedCount;
    }

    /**
     * Exports data to a single JSON file for portability
     */
    async exportToJson(agentId: string, outputPath: string): Promise<void> {
        const nodes = await this.readAllLines(path.join(agentId, 'nodes.jsonl'));
        const relations = await this.readAllLines(path.join(agentId, 'relations.jsonl'));
        const events = await this.readAllLines(path.join(agentId, 'events.jsonl'));
        
        const exportData = {
            exportDate: new Date().toISOString(),
            agentId,
            version: '1.0',
            data: {
                nodes,
                relations,
                events
            },
            statistics: {
                nodeCount: nodes.length,
                relationCount: relations.length,
                eventCount: events.length
            }
        };
        
        await fsp.writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf8');
    }

    /**
     * Imports data from a JSON export
     */
    async importFromJson(inputPath: string, targetAgentId?: string): Promise<void> {
        const importData = JSON.parse(await fsp.readFile(inputPath, 'utf8'));
        const agentId = targetAgentId || importData.agentId;
        
        await this.ensureDirectoryStructure(agentId);
        
        // Clear existing data
        const nodesPath = path.join(this.rootPath, agentId, 'nodes.jsonl');
        const relationsPath = path.join(this.rootPath, agentId, 'relations.jsonl');
        const eventsPath = path.join(this.rootPath, agentId, 'events.jsonl');
        
        // Backup existing data
        const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        if (fs.existsSync(nodesPath)) {
            await fsp.rename(nodesPath, `${nodesPath}.backup-${backupTimestamp}`);
        }
        if (fs.existsSync(relationsPath)) {
            await fsp.rename(relationsPath, `${relationsPath}.backup-${backupTimestamp}`);
        }
        if (fs.existsSync(eventsPath)) {
            await fsp.rename(eventsPath, `${eventsPath}.backup-${backupTimestamp}`);
        }
        
        // Import data
        for (const node of importData.data.nodes || []) {
            await this.appendLine(path.join(agentId, 'nodes.jsonl'), node);
        }
        
        for (const relation of importData.data.relations || []) {
            await this.appendLine(path.join(agentId, 'relations.jsonl'), relation);
        }
        
        for (const event of importData.data.events || []) {
            await this.appendLine(path.join(agentId, 'events.jsonl'), event);
        }
    }
}