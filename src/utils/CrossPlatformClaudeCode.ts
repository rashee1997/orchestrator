import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { execa } from 'execa';

export interface ClaudeCodeInstallationInfo {
    found: boolean;
    path?: string;
    version?: string;
    installationMethod?: string;
    error?: string;
}

export interface ClaudeCodePlatformConfig {
    platform: string;
    possiblePaths: string[];
    installCommands: string[];
    setupInstructions: string;
    configPaths?: string[];
}

/**
 * Cross-platform Claude Code CLI detection and configuration
 * Handles different installation methods and paths across operating systems
 */
export class CrossPlatformClaudeCode {
    private static instance: CrossPlatformClaudeCode;
    private platform: string;
    private homedir: string;

    private constructor() {
        this.platform = os.platform();
        this.homedir = os.homedir();
    }

    public static getInstance(): CrossPlatformClaudeCode {
        if (!CrossPlatformClaudeCode.instance) {
            CrossPlatformClaudeCode.instance = new CrossPlatformClaudeCode();
        }
        return CrossPlatformClaudeCode.instance;
    }

    /**
     * Get platform-specific Claude Code CLI paths to search
     */
    public getClaudeCodePaths(): string[] {
        const paths: string[] = [];

        switch (this.platform) {
            case 'win32': // Windows
                paths.push(
                    // Default PATH command
                    'claude',
                    'claude.exe',
                    // Common Windows installation paths
                    path.join(this.homedir, 'AppData', 'Local', 'Programs', 'Claude Code', 'claude.exe'),
                    path.join(this.homedir, 'AppData', 'Roaming', 'npm', 'claude.exe'),
                    path.join(this.homedir, 'AppData', 'Local', 'npm', 'claude.exe'),
                    // Chocolatey
                    'C:\\ProgramData\\chocolatey\\bin\\claude.exe',
                    // Scoop
                    path.join(this.homedir, 'scoop', 'apps', 'claude-code', 'current', 'claude.exe'),
                    // Global npm installations
                    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'claude.exe'),
                    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'usr', 'bin', 'claude.exe')
                );
                break;

            case 'darwin': // macOS
                paths.push(
                    // Default PATH command
                    'claude',
                    // Homebrew paths
                    '/opt/homebrew/bin/claude',
                    '/usr/local/bin/claude',
                    // MacPorts
                    '/opt/local/bin/claude',
                    // Node.js global installations
                    path.join(this.homedir, '.npm-global', 'bin', 'claude'),
                    '/usr/local/lib/node_modules/.bin/claude',
                    // Application bundle
                    '/Applications/Claude Code.app/Contents/MacOS/claude',
                    // User installations
                    path.join(this.homedir, 'bin', 'claude'),
                    path.join(this.homedir, '.local', 'bin', 'claude')
                );
                break;

            case 'linux': // Linux/Unix
            case 'freebsd':
            case 'openbsd':
            default:
                paths.push(
                    // Default PATH command
                    'claude',
                    // Standard Unix paths
                    '/usr/local/bin/claude',
                    '/usr/bin/claude',
                    '/bin/claude',
                    // User installations
                    path.join(this.homedir, '.local', 'bin', 'claude'),
                    path.join(this.homedir, 'bin', 'claude'),
                    // Node.js global installations
                    path.join(this.homedir, '.npm-global', 'bin', 'claude'),
                    '/usr/local/lib/node_modules/.bin/claude',
                    // Snap packages
                    '/snap/bin/claude',
                    // Flatpak
                    '/var/lib/flatpak/exports/bin/claude',
                    path.join(this.homedir, '.local', 'share', 'flatpak', 'exports', 'bin', 'claude'),
                    // AppImage
                    path.join(this.homedir, 'Applications', 'claude'),
                    path.join(this.homedir, '.local', 'share', 'applications', 'claude')
                );
                break;
        }

        return paths;
    }

    /**
     * Detect Claude Code CLI installation
     */
    public async detectClaudeCode(customPath?: string): Promise<ClaudeCodeInstallationInfo> {
        if (customPath) {
            return this.testClaudeCodePath(customPath);
        }

        const possiblePaths = this.getClaudeCodePaths();

        for (const claudePath of possiblePaths) {
            const result = await this.testClaudeCodePath(claudePath);
            if (result.found) {
                console.log(`[CrossPlatformClaudeCode] Found Claude Code at: ${result.path}`);
                return result;
            }
        }

        console.log(`[CrossPlatformClaudeCode] Claude Code CLI not found in any standard location for ${this.platform}`);
        return {
            found: false,
            error: `Claude Code CLI not found in any of ${possiblePaths.length} checked paths`
        };
    }

    /**
     * Test a specific Claude Code path
     */
    private async testClaudeCodePath(claudePath: string): Promise<ClaudeCodeInstallationInfo> {
        try {
            const result = await execa(claudePath, ['--version'], {
                timeout: 10000,
                stdio: 'pipe'
            });

            const version = result.stdout.trim();
            let installationMethod = 'unknown';

            // Try to determine installation method
            if (claudePath.includes('homebrew') || claudePath.includes('/opt/homebrew')) {
                installationMethod = 'Homebrew';
            } else if (claudePath.includes('chocolatey')) {
                installationMethod = 'Chocolatey';
            } else if (claudePath.includes('scoop')) {
                installationMethod = 'Scoop';
            } else if (claudePath.includes('snap')) {
                installationMethod = 'Snap';
            } else if (claudePath.includes('flatpak')) {
                installationMethod = 'Flatpak';
            } else if (claudePath.includes('npm') || claudePath.includes('node_modules')) {
                installationMethod = 'npm';
            } else if (claudePath === 'claude') {
                installationMethod = 'PATH';
            }

            return {
                found: true,
                path: claudePath,
                version,
                installationMethod
            };

        } catch (error: any) {
            return {
                found: false,
                error: error.message
            };
        }
    }

    /**
     * Get platform-specific installation instructions
     */
    public getPlatformConfig(): ClaudeCodePlatformConfig {
        switch (this.platform) {
            case 'win32':
                return {
                    platform: 'Windows',
                    possiblePaths: this.getClaudeCodePaths(),
                    installCommands: [
                        'npm install -g claude-code',
                        'choco install claude-code',
                        'scoop install claude-code'
                    ],
                    setupInstructions: `
Claude Code Installation for Windows:

Method 1 - npm (Recommended):
   npm install -g @anthropic/claude-code

Method 2 - Chocolatey:
   choco install claude-code

Method 3 - Scoop:
   scoop bucket add extras
   scoop install claude-code

Method 4 - Direct Download:
   1. Download from: https://docs.anthropic.com/en/docs/claude-code/setup
   2. Add to PATH: Add installation directory to your PATH environment variable

Verification:
   claude --version

Configuration paths:
   - %APPDATA%\\Claude Code\\
   - %USERPROFILE%\\.claude\\`,
                    configPaths: [
                        path.join(process.env.APPDATA || path.join(this.homedir, 'AppData', 'Roaming'), 'Claude Code'),
                        path.join(this.homedir, '.claude')
                    ]
                };

            case 'darwin':
                return {
                    platform: 'macOS',
                    possiblePaths: this.getClaudeCodePaths(),
                    installCommands: [
                        'brew install claude-code',
                        'npm install -g claude-code',
                        'port install claude-code'
                    ],
                    setupInstructions: `
Claude Code Installation for macOS:

Method 1 - Homebrew (Recommended):
   brew tap anthropic/claude-code
   brew install claude-code

Method 2 - npm:
   npm install -g @anthropic/claude-code

Method 3 - MacPorts:
   sudo port install claude-code

Method 4 - Direct Download:
   1. Download from: https://docs.anthropic.com/en/docs/claude-code/setup
   2. Move to /usr/local/bin or add to PATH

Verification:
   claude --version

Configuration paths:
   - ~/Library/Application Support/Claude Code/
   - ~/.claude/`,
                    configPaths: [
                        path.join(this.homedir, 'Library', 'Application Support', 'Claude Code'),
                        path.join(this.homedir, '.claude')
                    ]
                };

            default: // Linux and other Unix-like systems
                return {
                    platform: 'Linux/Unix',
                    possiblePaths: this.getClaudeCodePaths(),
                    installCommands: [
                        'npm install -g claude-code',
                        'snap install claude-code',
                        'flatpak install claude-code',
                        'apt install claude-code',
                        'yum install claude-code',
                        'pacman -S claude-code'
                    ],
                    setupInstructions: `
Claude Code Installation for Linux/Unix:

Method 1 - npm (Universal):
   npm install -g @anthropic/claude-code

Method 2 - Snap (Ubuntu/Universal):
   sudo snap install claude-code

Method 3 - Flatpak (Universal):
   flatpak install flathub com.anthropic.claude-code

Method 4 - Package Manager:
   # Debian/Ubuntu:
   sudo apt update && sudo apt install claude-code

   # RHEL/CentOS/Fedora:
   sudo yum install claude-code
   # or: sudo dnf install claude-code

   # Arch Linux:
   sudo pacman -S claude-code
   # or: yay -S claude-code-bin

Method 5 - Direct Download:
   1. Download from: https://docs.anthropic.com/en/docs/claude-code/setup
   2. Extract and move to /usr/local/bin or ~/.local/bin
   3. Make executable: chmod +x ~/.local/bin/claude

Verification:
   claude --version

Configuration paths:
   - ~/.config/claude-code/
   - ~/.claude/`,
                    configPaths: [
                        path.join(this.homedir, '.config', 'claude-code'),
                        path.join(this.homedir, '.claude')
                    ]
                };
        }
    }

    /**
     * Get optimal Claude Code path for the current platform
     */
    public async getOptimalClaudeCodePath(): Promise<string> {
        const detection = await this.detectClaudeCode();

        if (detection.found && detection.path) {
            return detection.path;
        }

        // Return default command and let the system handle PATH resolution
        return 'claude';
    }

    /**
     * Get comprehensive setup information
     */
    public async getSetupInfo(): Promise<{
        detection: ClaudeCodeInstallationInfo;
        platformConfig: ClaudeCodePlatformConfig;
        recommendations: string[];
    }> {
        const detection = await this.detectClaudeCode();
        const platformConfig = this.getPlatformConfig();

        const recommendations: string[] = [];

        if (!detection.found) {
            recommendations.push(
                `Claude Code CLI not found on ${platformConfig.platform}`,
                `Recommended installation: ${platformConfig.installCommands[0]}`,
                'See full setup instructions below'
            );
        } else {
            recommendations.push(
                `✅ Claude Code found: ${detection.path}`,
                `Version: ${detection.version}`,
                `Installation method: ${detection.installationMethod}`
            );
        }

        return {
            detection,
            platformConfig,
            recommendations
        };
    }

    /**
     * Test if a Claude Code installation is working
     */
    public async testClaudeCodeInstallation(customPath?: string): Promise<{
        success: boolean;
        path?: string;
        version?: string;
        error?: string;
        performance?: {
            detectionTime: number;
            versionCheckTime: number;
        };
    }> {
        const startTime = Date.now();

        try {
            const detection = await this.detectClaudeCode(customPath);
            const detectionTime = Date.now() - startTime;

            if (!detection.found) {
                return {
                    success: false,
                    error: detection.error,
                    performance: {
                        detectionTime,
                        versionCheckTime: 0
                    }
                };
            }

            const versionCheckStart = Date.now();
            const versionTest = await this.testClaudeCodePath(detection.path!);
            const versionCheckTime = Date.now() - versionCheckStart;

            return {
                success: versionTest.found,
                path: detection.path,
                version: detection.version,
                error: versionTest.found ? undefined : versionTest.error,
                performance: {
                    detectionTime,
                    versionCheckTime
                }
            };

        } catch (error: any) {
            return {
                success: false,
                error: error.message,
                performance: {
                    detectionTime: Date.now() - startTime,
                    versionCheckTime: 0
                }
            };
        }
    }

    /**
     * Get debug information for troubleshooting
     */
    public getDebugInfo(): {
        platform: string;
        homedir: string;
        possiblePaths: string[];
        environmentVars: { [key: string]: string | undefined };
        pathVariable: string[];
    } {
        const pathVar = process.env.PATH || process.env.Path || '';
        const pathDirs = pathVar.split(this.platform === 'win32' ? ';' : ':');

        return {
            platform: this.platform,
            homedir: this.homedir,
            possiblePaths: this.getClaudeCodePaths(),
            environmentVars: {
                PATH: process.env.PATH,
                PROGRAMFILES: process.env.PROGRAMFILES,
                APPDATA: process.env.APPDATA,
                LOCALAPPDATA: process.env.LOCALAPPDATA,
                HOME: process.env.HOME
            },
            pathVariable: pathDirs
        };
    }
}