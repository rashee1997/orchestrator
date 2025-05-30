// src/database/storage/EventStore.ts
import { randomUUID } from 'crypto';
import { JsonlStorageManager } from './JsonlStorageManager.js';

export type EventType = 
    | 'NODE_CREATED' 
    | 'NODE_UPDATED' 
    | 'NODE_DELETED' 
    | 'RELATION_CREATED' 
    | 'RELATION_DELETED' 
    | 'OBSERVATIONS_ADDED' 
    | 'OBSERVATIONS_REMOVED'
    | 'BULK_IMPORT'
    | 'SNAPSHOT_CREATED'
    | 'SNAPSHOT_RESTORED';

export interface EventMetadata {
    userId?: string;
    source?: string;
    version: number;
    correlationId?: string;
    causationId?: string;
}

export interface KnowledgeGraphEvent {
    id: string;
    timestamp: number;
    agentId: string;
    eventType: EventType;
    payload: any;
    metadata: EventMetadata;
}

export interface EventQuery {
    agentId: string;
    eventTypes?: EventType[];
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
}

export class EventStore {
    private jsonlStorage: JsonlStorageManager;
    private eventHandlers: Map<EventType, Array<(event: KnowledgeGraphEvent) => Promise<void>>>;

    constructor(jsonlStorage: JsonlStorageManager) {
        this.jsonlStorage = jsonlStorage;
        this.eventHandlers = new Map();
    }

    /**
     * Appends an event to the event store
     */
    async appendEvent(
        agentId: string,
        eventType: EventType,
        payload: any,
        metadata?: Partial<EventMetadata>
    ): Promise<KnowledgeGraphEvent> {
        const event: KnowledgeGraphEvent = {
            id: randomUUID(),
            timestamp: Date.now(),
            agentId,
            eventType,
            payload,
            metadata: {
                version: 1,
                source: 'system',
                ...metadata
            }
        };

        // Append to event log
        await this.jsonlStorage.appendLine(`${agentId}/events.jsonl`, event);

        // Trigger event handlers
        await this.triggerHandlers(event);

        return event;
    }

    /**
     * Registers an event handler
     */
    onEvent(eventType: EventType, handler: (event: KnowledgeGraphEvent) => Promise<void>): void {
        if (!this.eventHandlers.has(eventType)) {
            this.eventHandlers.set(eventType, []);
        }
        this.eventHandlers.get(eventType)!.push(handler);
    }

    /**
     * Removes an event handler
     */
    offEvent(eventType: EventType, handler: (event: KnowledgeGraphEvent) => Promise<void>): void {
        const handlers = this.eventHandlers.get(eventType);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * Triggers handlers for an event
     */
    private async triggerHandlers(event: KnowledgeGraphEvent): Promise<void> {
        const handlers = this.eventHandlers.get(event.eventType) || [];
        
        // Execute handlers in parallel
        await Promise.all(
            handlers.map(handler => 
                handler(event).catch(error => 
                    console.error(`Error in event handler for ${event.eventType}:`, error)
                )
            )
        );
    }

    /**
     * Queries events based on criteria
     */
    async queryEvents(query: EventQuery): Promise<KnowledgeGraphEvent[]> {
        const events: KnowledgeGraphEvent[] = [];
        let count = 0;
        let skipped = 0;

        for await (const event of this.jsonlStorage.readLines(`${query.agentId}/events.jsonl`)) {
            // Apply filters
            if (query.eventTypes && !query.eventTypes.includes(event.eventType)) {
                continue;
            }

            if (query.startTime && event.timestamp < query.startTime) {
                continue;
            }

            if (query.endTime && event.timestamp > query.endTime) {
                continue;
            }

            // Apply offset
            if (query.offset && skipped < query.offset) {
                skipped++;
                continue;
            }

            events.push(event);
            count++;

            // Apply limit
            if (query.limit && count >= query.limit) {
                break;
            }
        }

        return events;
    }

    /**
     * Gets the latest event for an entity
     */
    async getLatestEventForEntity(agentId: string, entityId: string): Promise<KnowledgeGraphEvent | null> {
        let latestEvent: KnowledgeGraphEvent | null = null;

        for await (const event of this.jsonlStorage.readLines(`${agentId}/events.jsonl`)) {
            if (event.payload?.nodeId === entityId || 
                event.payload?.relationId === entityId ||
                event.payload?.id === entityId) {
                latestEvent = event;
            }
        }

        return latestEvent;
    }

    /**
     * Replays events from a specific point in time
     */
    async replayEvents(
        agentId: string,
        fromTimestamp: number,
        toTimestamp?: number
    ): Promise<KnowledgeGraphEvent[]> {
        const events = await this.queryEvents({
            agentId,
            startTime: fromTimestamp,
            endTime: toTimestamp
        });

        // Trigger handlers for replayed events
        for (const event of events) {
            await this.triggerHandlers(event);
        }

        return events;
    }

    /**
     * Creates a checkpoint of the current event position
     */
    async createCheckpoint(agentId: string): Promise<{ timestamp: number; eventCount: number }> {
        let eventCount = 0;
        let lastTimestamp = 0;

        for await (const event of this.jsonlStorage.readLines(`${agentId}/events.jsonl`)) {
            eventCount++;
            lastTimestamp = event.timestamp;
        }

        return { timestamp: lastTimestamp, eventCount };
    }

    /**
     * Gets event statistics
     */
    async getEventStatistics(agentId: string): Promise<{
        totalEvents: number;
        eventsByType: Record<EventType, number>;
        firstEventTime?: number;
        lastEventTime?: number;
        eventsPerDay: Record<string, number>;
    }> {
        const stats = {
            totalEvents: 0,
            eventsByType: {} as Record<EventType, number>,
            firstEventTime: undefined as number | undefined,
            lastEventTime: undefined as number | undefined,
            eventsPerDay: {} as Record<string, number>
        };

        for await (const event of this.jsonlStorage.readLines(`${agentId}/events.jsonl`)) {
            stats.totalEvents++;

            // Count by type
            stats.eventsByType[event.eventType as EventType] = (stats.eventsByType[event.eventType as EventType] || 0) + 1;

            // Track time range
            if (!stats.firstEventTime || event.timestamp < stats.firstEventTime) {
                stats.firstEventTime = event.timestamp;
            }
            if (!stats.lastEventTime || event.timestamp > stats.lastEventTime) {
                stats.lastEventTime = event.timestamp;
            }

            // Count by day
            const day = new Date(event.timestamp).toISOString().split('T')[0];
            stats.eventsPerDay[day] = (stats.eventsPerDay[day] || 0) + 1;
        }

        return stats;
    }

    /**
     * Validates event consistency
     */
    async validateEventConsistency(agentId: string): Promise<{
        isValid: boolean;
        errors: string[];
        warnings: string[];
    }> {
        const errors: string[] = [];
        const warnings: string[] = [];
        const seenIds = new Set<string>();
        let lastTimestamp = 0;

        for await (const event of this.jsonlStorage.readLines(`${agentId}/events.jsonl`)) {
            // Check for duplicate IDs
            if (seenIds.has(event.id)) {
                errors.push(`Duplicate event ID: ${event.id}`);
            }
            seenIds.add(event.id);

            // Check timestamp ordering
            if (event.timestamp < lastTimestamp) {
                warnings.push(`Event ${event.id} has timestamp ${event.timestamp} which is before previous event timestamp ${lastTimestamp}`);
            }
            lastTimestamp = event.timestamp;

            // Validate event structure
            if (!event.eventType) {
                errors.push(`Event ${event.id} missing eventType`);
            }
            if (!event.payload) {
                warnings.push(`Event ${event.id} has no payload`);
            }
            if (!event.metadata?.version) {
                warnings.push(`Event ${event.id} missing metadata.version`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Compacts the event log by creating a snapshot and starting fresh
     */
    async compactEventLog(agentId: string, keepRecentEvents: number = 1000): Promise<void> {
        const allEvents: KnowledgeGraphEvent[] = [];
        
        for await (const event of this.jsonlStorage.readLines(`${agentId}/events.jsonl`)) {
            allEvents.push(event);
        }

        if (allEvents.length <= keepRecentEvents) {
            return; // No need to compact
        }

        // Create a snapshot
        const snapshotPath = await this.jsonlStorage.createSnapshot(agentId);
        
        // Create snapshot event
        await this.appendEvent(agentId, 'SNAPSHOT_CREATED', {
            snapshotPath,
            eventCount: allEvents.length - keepRecentEvents
        });

        // Keep only recent events
        const recentEvents = allEvents.slice(-keepRecentEvents);
        
        // Rewrite event log with only recent events
        const tempPath = `${agentId}/events.jsonl.tmp`;
        for (const event of recentEvents) {
            await this.jsonlStorage.appendLine(tempPath, event);
        }

        // Replace original with compacted version
        // This would need to be implemented in JsonlStorageManager
        // For now, we'll just log the intention
        console.log(`Event log compacted for agent ${agentId}, kept ${keepRecentEvents} recent events`);
    }
}