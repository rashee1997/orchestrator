/**
 * Configurable logging framework for Memory MCP Server
 * Provides structured logging with configurable levels and outputs
 */

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    SILENT = 4
}

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    component: string;
    message: string;
    metadata?: Record<string, any>;
    error?: Error;
}

export interface LoggerConfig {
    level: LogLevel;
    outputs: LogOutput[];
    includeTimestamp: boolean;
    includeComponent: boolean;
    formatJson: boolean;
}

export interface LogOutput {
    write(entry: LogEntry): Promise<void> | void;
}

/**
 * Console output for logs
 */
export class ConsoleOutput implements LogOutput {
    private readonly colors: Record<LogLevel, string> = {
        [LogLevel.DEBUG]: '\x1b[36m', // Cyan
        [LogLevel.INFO]: '\x1b[32m',  // Green
        [LogLevel.WARN]: '\x1b[33m',  // Yellow
        [LogLevel.ERROR]: '\x1b[31m', // Red
        [LogLevel.SILENT]: ''         // No color for silent
    };

    private readonly reset = '\x1b[0m';

    write(entry: LogEntry): void {
        const color = this.colors[entry.level] || '';
        const levelName = LogLevel[entry.level];

        let message = `${color}[${levelName}]${this.reset}`;

        if (entry.timestamp) {
            message += ` ${entry.timestamp}`;
        }

        if (entry.component) {
            message += ` [${entry.component}]`;
        }

        message += ` ${entry.message}`;

        if (entry.metadata && Object.keys(entry.metadata).length > 0) {
            message += ` ${JSON.stringify(entry.metadata)}`;
        }

        // Use appropriate console method
        switch (entry.level) {
            case LogLevel.DEBUG:
                console.debug(message);
                break;
            case LogLevel.INFO:
                console.info(message);
                break;
            case LogLevel.WARN:
                console.warn(message);
                if (entry.error) console.warn(entry.error);
                break;
            case LogLevel.ERROR:
                console.error(message);
                if (entry.error) console.error(entry.error);
                break;
        }
    }
}

/**
 * File output for logs (optional, for production environments)
 */
export class FileOutput implements LogOutput {
    constructor(private filePath: string) {}

    async write(entry: LogEntry): Promise<void> {
        const fs = await import('fs/promises');
        const logLine = JSON.stringify(entry) + '\n';
        await fs.appendFile(this.filePath, logLine);
    }
}

/**
 * Main Logger class
 */
export class Logger {
    private static instance: Logger;
    private config: LoggerConfig;

    private constructor(config?: Partial<LoggerConfig>) {
        this.config = {
            level: LogLevel.INFO,
            outputs: [new ConsoleOutput()],
            includeTimestamp: true,
            includeComponent: true,
            formatJson: false,
            ...config
        };
    }

    /**
     * Get singleton logger instance
     */
    static getInstance(config?: Partial<LoggerConfig>): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger(config);
        }
        return Logger.instance;
    }

    /**
     * Configure logger settings
     */
    configure(config: Partial<LoggerConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Create a component-specific logger
     */
    component(componentName: string): ComponentLogger {
        return new ComponentLogger(this, componentName);
    }

    /**
     * Set log level
     */
    setLevel(level: LogLevel): void {
        this.config.level = level;
    }

    /**
     * Add log output
     */
    addOutput(output: LogOutput): void {
        this.config.outputs.push(output);
    }

    /**
     * Log a message
     */
    async log(level: LogLevel, component: string, message: string, metadata?: Record<string, any>, error?: Error): Promise<void> {
        if (level < this.config.level) {
            return; // Skip if below configured level
        }

        const entry: LogEntry = {
            timestamp: this.config.includeTimestamp ? new Date().toISOString() : '',
            level,
            component: this.config.includeComponent ? component : '',
            message,
            metadata,
            error
        };

        // Write to all outputs
        await Promise.all(
            this.config.outputs.map(output => output.write(entry))
        );
    }

    // Convenience methods
    async debug(component: string, message: string, metadata?: Record<string, any>): Promise<void> {
        await this.log(LogLevel.DEBUG, component, message, metadata);
    }

    async info(component: string, message: string, metadata?: Record<string, any>): Promise<void> {
        await this.log(LogLevel.INFO, component, message, metadata);
    }

    async warn(component: string, message: string, metadata?: Record<string, any>, error?: Error): Promise<void> {
        await this.log(LogLevel.WARN, component, message, metadata, error);
    }

    async error(component: string, message: string, metadata?: Record<string, any>, error?: Error): Promise<void> {
        await this.log(LogLevel.ERROR, component, message, metadata, error);
    }
}

/**
 * Component-specific logger that automatically includes component name
 */
export class ComponentLogger {
    constructor(
        private logger: Logger,
        private componentName: string
    ) {}

    async debug(message: string, metadata?: Record<string, any>): Promise<void> {
        await this.logger.debug(this.componentName, message, metadata);
    }

    async info(message: string, metadata?: Record<string, any>): Promise<void> {
        await this.logger.info(this.componentName, message, metadata);
    }

    async warn(message: string, metadata?: Record<string, any>, error?: Error): Promise<void> {
        await this.logger.warn(this.componentName, message, metadata, error);
    }

    async error(message: string, metadata?: Record<string, any>, error?: Error): Promise<void> {
        await this.logger.error(this.componentName, message, metadata, error);
    }
}

/**
 * Global logger instance for easy access
 */
export const logger = Logger.getInstance();

/**
 * Environment-based logger configuration
 */
export function configureLoggerForEnvironment(): void {
    const env = process.env.NODE_ENV || 'development';
    const logLevel = process.env.LOG_LEVEL || 'INFO';

    let level: LogLevel;
    switch (logLevel.toUpperCase()) {
        case 'DEBUG':
            level = LogLevel.DEBUG;
            break;
        case 'INFO':
            level = LogLevel.INFO;
            break;
        case 'WARN':
            level = LogLevel.WARN;
            break;
        case 'ERROR':
            level = LogLevel.ERROR;
            break;
        case 'SILENT':
            level = LogLevel.SILENT;
            break;
        default:
            level = LogLevel.INFO;
    }

    const config: Partial<LoggerConfig> = {
        level,
        includeTimestamp: true,
        includeComponent: true,
        formatJson: env === 'production'
    };

    // Add file output in production
    if (env === 'production' && process.env.LOG_FILE) {
        config.outputs = [
            new ConsoleOutput(),
            new FileOutput(process.env.LOG_FILE)
        ];
    }

    logger.configure(config);
}

/**
 * Utility function to replace console.log calls
 */
export function createLegacyLoggerReplacement(componentName: string) {
    const componentLogger = logger.component(componentName);

    return {
        log: (message: string, ...args: any[]) => {
            const metadata = args.length > 0 ? { args } : undefined;
            componentLogger.info(message, metadata);
        },
        error: (message: string, ...args: any[]) => {
            const error = args.find(arg => arg instanceof Error);
            const metadata = args.filter(arg => !(arg instanceof Error));
            componentLogger.error(message, metadata.length > 0 ? { args: metadata } : undefined, error);
        },
        warn: (message: string, ...args: any[]) => {
            const error = args.find(arg => arg instanceof Error);
            const metadata = args.filter(arg => !(arg instanceof Error));
            componentLogger.warn(message, metadata.length > 0 ? { args: metadata } : undefined, error);
        },
        debug: (message: string, ...args: any[]) => {
            const metadata = args.length > 0 ? { args } : undefined;
            componentLogger.debug(message, metadata);
        }
    };
}