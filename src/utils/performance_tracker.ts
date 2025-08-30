/**
 * Performance tracking utilities for RAG operations.
 * Provides detailed metrics and timing information.
 */

export interface PerformanceMetrics {
    operation: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    metadata: Record<string, any>;
    success: boolean;
    error?: string;
}

export interface RagPerformanceSummary {
    totalOperations: number;
    totalDuration: number;
    averageDuration: number;
    successRate: number;
    operationsByType: Record<string, {
        count: number;
        totalDuration: number;
        averageDuration: number;
        successCount: number;
    }>;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
    contextItemsProcessed: number;
    contextItemsDeduplicated: number;
    deduplicationRatio: number;
}

export class PerformanceTracker {
    private metrics: PerformanceMetrics[] = [];
    private activeOperations: Map<string, PerformanceMetrics> = new Map();

    /**
     * Start tracking a performance operation.
     */
    startOperation(operation: string, metadata: Record<string, any> = {}): string {
        const operationId = `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const metric: PerformanceMetrics = {
            operation,
            startTime: Date.now(),
            metadata,
            success: false
        };

        this.activeOperations.set(operationId, metric);
        console.log(`[PerformanceTracker] Started: ${operation} (${operationId})`);
        return operationId;
    }

    /**
     * End tracking a performance operation.
     */
    endOperation(operationId: string, success: boolean = true, error?: string): void {
        const metric = this.activeOperations.get(operationId);
        if (!metric) {
            console.warn(`[PerformanceTracker] Operation not found: ${operationId}`);
            return;
        }

        metric.endTime = Date.now();
        metric.duration = metric.endTime - metric.startTime;
        metric.success = success;
        if (error) {
            metric.error = error;
        }

        this.metrics.push(metric);
        this.activeOperations.delete(operationId);

        console.log(`[PerformanceTracker] Completed: ${metric.operation} (${operationId}) - ${metric.duration}ms - ${success ? 'SUCCESS' : 'FAILED'}`);
    }

    /**
     * Record a completed operation with known duration.
     */
    recordOperation(operation: string, duration: number, success: boolean = true, metadata: Record<string, any> = {}, error?: string): void {
        const metric: PerformanceMetrics = {
            operation,
            startTime: Date.now() - duration,
            endTime: Date.now(),
            duration,
            metadata,
            success,
            error
        };

        this.metrics.push(metric);
        console.log(`[PerformanceTracker] Recorded: ${operation} - ${duration}ms - ${success ? 'SUCCESS' : 'FAILED'}`);
    }

    /**
     * Get performance summary for all recorded operations.
     */
    getSummary(): RagPerformanceSummary {
        const totalOperations = this.metrics.length;
        const successfulOperations = this.metrics.filter(m => m.success);
        const totalDuration = this.metrics.reduce((sum, m) => sum + (m.duration || 0), 0);
        const averageDuration = totalOperations > 0 ? totalDuration / totalOperations : 0;
        const successRate = totalOperations > 0 ? (successfulOperations.length / totalOperations) * 100 : 0;

        // Group by operation type
        const operationsByType: Record<string, { count: number; totalDuration: number; averageDuration: number; successCount: number }> = {};
        this.metrics.forEach(metric => {
            if (!operationsByType[metric.operation]) {
                operationsByType[metric.operation] = { count: 0, totalDuration: 0, averageDuration: 0, successCount: 0 };
            }
            operationsByType[metric.operation].count++;
            operationsByType[metric.operation].totalDuration += metric.duration || 0;
            if (metric.success) {
                operationsByType[metric.operation].successCount++;
            }
        });

        // Calculate averages
        Object.keys(operationsByType).forEach(op => {
            const opData = operationsByType[op];
            opData.averageDuration = opData.count > 0 ? opData.totalDuration / opData.count : 0;
        });

        // Calculate cache metrics
        const cacheOperations = this.metrics.filter(m => m.operation.includes('cache'));
        const cacheHits = cacheOperations.filter(m => m.metadata.cacheHit === true).length;
        const cacheMisses = cacheOperations.filter(m => m.metadata.cacheHit === false).length;
        const cacheHitRate = (cacheHits + cacheMisses) > 0 ? (cacheHits / (cacheHits + cacheMisses)) * 100 : 0;

        // Calculate deduplication metrics
        const deduplicationOperations = this.metrics.filter(m => m.operation.includes('deduplication'));
        const contextItemsProcessed = deduplicationOperations.reduce((sum, m) => sum + (m.metadata.contextItemsProcessed || 0), 0);
        const contextItemsDeduplicated = deduplicationOperations.reduce((sum, m) => sum + (m.metadata.contextItemsDeduplicated || 0), 0);
        const deduplicationRatio = contextItemsProcessed > 0 ? ((contextItemsProcessed - contextItemsDeduplicated) / contextItemsProcessed) * 100 : 0;

        return {
            totalOperations,
            totalDuration,
            averageDuration,
            successRate,
            operationsByType,
            cacheHits,
            cacheMisses,
            cacheHitRate,
            contextItemsProcessed,
            contextItemsDeduplicated,
            deduplicationRatio
        };
    }

    /**
     * Clear all recorded metrics.
     */
    clear(): void {
        this.metrics = [];
        this.activeOperations.clear();
        console.log('[PerformanceTracker] Cleared all metrics');
    }

    /**
     * Get recent metrics (last N operations).
     */
    getRecentMetrics(count: number = 10): PerformanceMetrics[] {
        return this.metrics.slice(-count);
    }

    /**
     * Export metrics for analysis.
     */
    exportMetrics(): PerformanceMetrics[] {
        return [...this.metrics];
    }
}

// Global performance tracker instance
export const globalPerformanceTracker = new PerformanceTracker();
