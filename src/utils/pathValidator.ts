import * as path from 'path';
import * as fs from 'fs/promises';
import { Stats, Dirent } from 'fs';

/**
 * Security utility for validating and sanitizing file paths to prevent path traversal attacks
 */
export class PathValidator {
    private static readonly DANGEROUS_PATTERNS = [
        /\.\./,           // Parent directory traversal
        /\/\//,           // Double slashes
        /\\{2,}/,         // Multiple backslashes
        /[<>:"|?*]/,      // Invalid filename characters
        /^[A-Z]:/,        // Windows drive letters (if not expected)
    ];

    private static readonly MAX_PATH_LENGTH = 260; // Windows MAX_PATH limit

    /**
     * Validates that a path is safe and within allowed boundaries
     * @param inputPath - The path to validate
     * @param allowedBasePath - Optional base path that the input must be within
     * @returns Promise<string> - The normalized, safe path
     * @throws Error if path is invalid or potentially dangerous
     */
    static async validatePath(inputPath: string, allowedBasePath?: string): Promise<string> {
        if (!inputPath || typeof inputPath !== 'string') {
            throw new Error('Path must be a non-empty string');
        }

        if (inputPath.length > this.MAX_PATH_LENGTH) {
            throw new Error(`Path length exceeds maximum allowed (${this.MAX_PATH_LENGTH} characters)`);
        }

        // Check for dangerous patterns
        for (const pattern of this.DANGEROUS_PATTERNS) {
            if (pattern.test(inputPath)) {
                throw new Error(`Path contains potentially dangerous pattern: ${inputPath}`);
            }
        }

        // Normalize the path to resolve any relative components
        const normalizedPath = path.normalize(inputPath);

        // If allowedBasePath is provided, ensure the path is within it
        if (allowedBasePath) {
            const resolvedBasePath = path.resolve(allowedBasePath);
            const resolvedInputPath = path.resolve(normalizedPath);

            if (!resolvedInputPath.startsWith(resolvedBasePath)) {
                throw new Error(`Path is outside allowed base directory: ${inputPath}`);
            }
        }

        return normalizedPath;
    }

    /**
     * Safely joins path components while validating the result
     * @param basePath - The base path
     * @param ...components - Path components to join
     * @returns Promise<string> - The safely joined path
     */
    static async safePath(basePath: string, ...components: string[]): Promise<string> {
        // Validate base path
        const validBasePath = await this.validatePath(basePath);

        // Validate and sanitize each component
        const validComponents = await Promise.all(
            components.map(async (component) => {
                if (!component || typeof component !== 'string') {
                    throw new Error('All path components must be non-empty strings');
                }

                // Remove dangerous characters from individual components
                const sanitized = component.replace(/[<>:"|?*]/g, '');

                if (sanitized !== component) {
                    console.warn(`Path component sanitized: "${component}" -> "${sanitized}"`);
                }

                return sanitized;
            })
        );

        // Join paths safely
        const joinedPath = path.join(validBasePath, ...validComponents);

        // Final validation of the complete path
        return this.validatePath(joinedPath, validBasePath);
    }

    /**
     * Checks if a path exists and is accessible
     * @param filePath - The path to check
     * @returns Promise<boolean> - True if path exists and is accessible
     */
    static async pathExists(filePath: string): Promise<boolean> {
        try {
            const validPath = await this.validatePath(filePath);
            await fs.access(validPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Gets file stats safely
     * @param filePath - The file path
     * @returns Promise<Stats> - File statistics
     */
    static async safeStats(filePath: string): Promise<Stats> {
        const validPath = await this.validatePath(filePath);
        return fs.stat(validPath);
    }

    /**
     * Reads directory contents safely
     * @param dirPath - The directory path
     * @param options - Optional readdir options
     * @returns Promise<Dirent[]> - Directory entries
     */
    static async safeReaddir(dirPath: string, options?: { withFileTypes: true }): Promise<Dirent[]> {
        const validPath = await this.validatePath(dirPath);
        return fs.readdir(validPath, options || { withFileTypes: true });
    }

    /**
     * Reads file content safely
     * @param filePath - The file path
     * @param encoding - File encoding (default: 'utf-8')
     * @returns Promise<string> - File content
     */
    static async safeReadFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
        const validPath = await this.validatePath(filePath);
        return fs.readFile(validPath, encoding);
    }

    /**
     * Validates that a path is within a project directory (additional security layer)
     * @param filePath - The file path to validate
     * @param projectRoot - The project root directory
     * @returns Promise<string> - The validated path
     */
    static async validateProjectPath(filePath: string, projectRoot: string): Promise<string> {
        const resolvedProjectRoot = path.resolve(projectRoot);
        const validPath = await this.validatePath(filePath, resolvedProjectRoot);

        // Additional check: ensure we're not accessing system directories
        const systemDirs = ['/etc', '/bin', '/usr/bin', '/system', 'C:\\Windows', 'C:\\System'];
        const resolvedPath = path.resolve(validPath);

        for (const sysDir of systemDirs) {
            if (resolvedPath.startsWith(sysDir)) {
                throw new Error(`Access to system directory not allowed: ${resolvedPath}`);
            }
        }

        return validPath;
    }
}