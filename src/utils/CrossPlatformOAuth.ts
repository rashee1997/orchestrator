import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

export interface OAuthCredentials {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expiry_date: number;
}

export interface OAuthCredentialResult {
    credentials: OAuthCredentials;
    path: string;
}

/**
 * Cross-platform OAuth credentials manager
 * Handles different OS-specific credential storage paths
 */
export class CrossPlatformOAuth {
    private static instance: CrossPlatformOAuth;
    private platform: string;
    private homedir: string;

    private constructor() {
        this.platform = os.platform();
        this.homedir = os.homedir();
    }

    public static getInstance(): CrossPlatformOAuth {
        if (!CrossPlatformOAuth.instance) {
            CrossPlatformOAuth.instance = new CrossPlatformOAuth();
        }
        return CrossPlatformOAuth.instance;
    }

    /**
     * Get platform-specific OAuth credential paths in order of preference
     */
    public getCredentialPaths(customPath?: string): string[] {
        if (customPath) {
            return [customPath];
        }

        const paths: string[] = [];

        switch (this.platform) {
            case 'win32': // Windows
                paths.push(
                    // Modern Windows applications typically use AppData/Roaming
                    path.join(this.homedir, 'AppData', 'Roaming', 'gemini', 'oauth_creds.json'),
                    // Fallback to Unix-style for compatibility
                    path.join(this.homedir, '.gemini', 'oauth_creds.json'),
                    // Google-style path
                    path.join(this.homedir, 'AppData', 'Local', 'Google', 'gemini', 'oauth_creds.json'),
                    // AppData/Local as alternative
                    path.join(this.homedir, 'AppData', 'Local', 'gemini', 'oauth_creds.json')
                );
                break;

            case 'darwin': // macOS
                paths.push(
                    // macOS Application Support (preferred for app data)
                    path.join(this.homedir, 'Library', 'Application Support', 'gemini', 'oauth_creds.json'),
                    // Unix-style hidden directory (common fallback)
                    path.join(this.homedir, '.gemini', 'oauth_creds.json'),
                    // XDG-style config directory
                    path.join(this.homedir, '.config', 'gemini', 'oauth_creds.json'),
                    // Library/Preferences alternative
                    path.join(this.homedir, 'Library', 'Preferences', 'gemini', 'oauth_creds.json')
                );
                break;

            case 'linux': // Linux/Unix
            case 'freebsd':
            case 'openbsd':
            case 'sunos':
            default:
                paths.push(
                    // Traditional Unix hidden directory (current implementation)
                    path.join(this.homedir, '.gemini', 'oauth_creds.json'),
                    // XDG Base Directory Specification (modern Linux standard)
                    path.join(this.homedir, '.config', 'gemini', 'oauth_creds.json'),
                    // XDG data directory
                    path.join(this.homedir, '.local', 'share', 'gemini', 'oauth_creds.json'),
                    // Environment-based XDG paths
                    path.join(process.env.XDG_CONFIG_HOME || path.join(this.homedir, '.config'), 'gemini', 'oauth_creds.json'),
                    path.join(process.env.XDG_DATA_HOME || path.join(this.homedir, '.local', 'share'), 'gemini', 'oauth_creds.json')
                );
                break;
        }

        return paths;
    }

    /**
     * Load OAuth credentials from the first available valid path
     */
    public async loadCredentials(customPath?: string): Promise<OAuthCredentialResult | null> {
        const possiblePaths = this.getCredentialPaths(customPath);

        for (const credPath of possiblePaths) {
            try {
                const credData = await fs.readFile(credPath, 'utf-8');
                const credentials = JSON.parse(credData) as OAuthCredentials;

                // Validate required fields
                if (credentials.access_token && credentials.refresh_token) {
                    console.log(`[CrossPlatformOAuth] Loaded credentials from: ${credPath}`);
                    return { credentials, path: credPath };
                } else {
                    console.warn(`[CrossPlatformOAuth] Invalid credentials format in: ${credPath}`);
                }
            } catch (error: any) {
                // Continue to next path on any error (file not found, invalid JSON, etc.)
                if (error.code !== 'ENOENT') {
                    console.warn(`[CrossPlatformOAuth] Error reading ${credPath}:`, error.message);
                }
                continue;
            }
        }

        console.log(`[CrossPlatformOAuth] No valid credentials found in any platform-specific path for ${this.platform}`);
        return null;
    }

    /**
     * Save OAuth credentials to the preferred platform-specific path
     */
    public async saveCredentials(credentials: OAuthCredentials, customPath?: string): Promise<string> {
        const preferredPath = this.getCredentialPaths(customPath)[0];

        try {
            // Ensure directory exists
            await fs.mkdir(path.dirname(preferredPath), { recursive: true });

            // Save credentials with pretty formatting
            await fs.writeFile(preferredPath, JSON.stringify(credentials, null, 2), 'utf-8');

            console.log(`[CrossPlatformOAuth] Saved credentials to: ${preferredPath}`);
            return preferredPath;
        } catch (error: any) {
            throw new Error(`Failed to save OAuth credentials to ${preferredPath}: ${error.message}`);
        }
    }

    /**
     * Check if OAuth credentials exist on this platform
     */
    public async checkCredentialsExist(customPath?: string): Promise<{ exists: boolean; path?: string; valid?: boolean }> {
        const possiblePaths = this.getCredentialPaths(customPath);

        for (const credPath of possiblePaths) {
            try {
                const credData = await fs.readFile(credPath, 'utf-8');
                const credentials = JSON.parse(credData);
                const valid = !!(credentials.access_token && credentials.refresh_token);

                return {
                    exists: true,
                    path: credPath,
                    valid
                };
            } catch (error) {
                continue;
            }
        }

        return { exists: false };
    }

    /**
     * Get platform-specific setup instructions
     */
    public getSetupInstructions(): string {
        const preferredPath = this.getCredentialPaths()[0];

        return `
To enable OAuth for Gemini 2.5 models (60 RPM free tier):

1. Install Gemini CLI:
   npm install -g @google/generative-ai

2. Authenticate:
   gemini auth

3. OAuth credentials will be saved to:
   ${preferredPath}

4. Restart your application to use OAuth for Gemini 2.5 models

Platform: ${this.platform}
Alternative paths checked:
${this.getCredentialPaths().map((p, i) => `   ${i + 1}. ${p}`).join('\n')}

Note: Embedding models will continue using API keys.`;
    }

    /**
     * Get platform and path information for debugging
     */
    public getDebugInfo(): {
        platform: string;
        homedir: string;
        paths: string[];
        environmentVars: { [key: string]: string | undefined };
    } {
        return {
            platform: this.platform,
            homedir: this.homedir,
            paths: this.getCredentialPaths(),
            environmentVars: {
                XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
                XDG_DATA_HOME: process.env.XDG_DATA_HOME,
                APPDATA: process.env.APPDATA,
                LOCALAPPDATA: process.env.LOCALAPPDATA,
                HOME: process.env.HOME
            }
        };
    }

    /**
     * Migrate credentials from old path to preferred platform path
     */
    public async migrateCredentials(oldPath: string): Promise<boolean> {
        try {
            const credData = await fs.readFile(oldPath, 'utf-8');
            const credentials = JSON.parse(credData) as OAuthCredentials;

            if (credentials.access_token && credentials.refresh_token) {
                const newPath = await this.saveCredentials(credentials);
                console.log(`[CrossPlatformOAuth] Migrated credentials from ${oldPath} to ${newPath}`);
                return true;
            }
        } catch (error: any) {
            console.error(`[CrossPlatformOAuth] Failed to migrate credentials:`, error.message);
        }

        return false;
    }
}