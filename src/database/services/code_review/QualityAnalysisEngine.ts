import { CodeReviewContext } from './CodeReviewService.js';
import { CODE_QUALITY_PATTERNS, QualityMetrics } from './QualityPatterns.js';

export interface QualityFinding {
  id: string;
  engine: 'security' | 'performance' | 'maintainability' | 'reliability';
  severity: 'BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
  category: string;
  rule: string;
  title: string;
  description: string;
  file: string;
  line: number;
  column?: number;
  impact: string;
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number; // 0-100
  cweId?: string;
  pattern?: string;
}

export class QualityAnalysisEngine {
  private findings: QualityFinding[] = [];

  constructor() {}

  /**
   * Main analysis entry point - runs all engines
   */
  async analyzeContext(context: CodeReviewContext): Promise<{
    findings: QualityFinding[];
    metrics: QualityMetrics;
    qualityGateStatus: 'PASS' | 'FAIL' | 'WARNING';
    technicalDebtHours: number;
  }> {
    this.findings = [];

    // Run all analysis engines in parallel for performance
    const analysisPromises = [
      this.runSecurityEngine(context),
      this.runPerformanceEngine(context),
      this.runMaintainabilityEngine(context),
      this.runReliabilityEngine(context)
    ];

    await Promise.all(analysisPromises);

    // Calculate quality metrics
    const metrics = this.calculateQualityMetrics();
    const qualityGateStatus = this.evaluateQualityGate(metrics);
    const technicalDebtHours = this.calculateTechnicalDebt();

    return {
      findings: this.findings.sort((a, b) => this.getSeverityWeight(b.severity) - this.getSeverityWeight(a.severity)),
      metrics,
      qualityGateStatus,
      technicalDebtHours
    };
  }

  /**
   * Security Engine - Detects vulnerabilities and security issues
   */
  private async runSecurityEngine(context: CodeReviewContext): Promise<void> {
    for (const file of context.file_snapshots) {
      if (!file.after) continue;

      await this.analyzeForCommandInjection(file.path, file.after);
      await this.analyzeForSqlInjection(file.path, file.after);
      await this.analyzeForXss(file.path, file.after);
      await this.analyzeForHardcodedSecrets(file.path, file.after);
      await this.analyzeForInsecureCrypto(file.path, file.after);
    }
  }

  /**
   * Performance Engine - Detects performance issues
   */
  private async runPerformanceEngine(context: CodeReviewContext): Promise<void> {
    for (const file of context.file_snapshots) {
      if (!file.after) continue;

      await this.analyzeForNestedLoops(file.path, file.after);
      await this.analyzeForBlockingIo(file.path, file.after);
      await this.analyzeForLargeObjects(file.path, file.after);
      await this.analyzeForIneffientAlgorithms(file.path, file.after);
    }
  }

  /**
   * Maintainability Engine - Code quality and maintainability
   */
  private async runMaintainabilityEngine(context: CodeReviewContext): Promise<void> {
    for (const file of context.file_snapshots) {
      if (!file.after) continue;

      await this.analyzeComplexity(file.path, file.after);
      await this.analyzeDuplication(file.path, file.after);
      await this.analyzeNaming(file.path, file.after);
      await this.analyzeMethodLength(file.path, file.after);
    }
  }

  /**
   * Reliability Engine - Error handling and robustness
   */
  private async runReliabilityEngine(context: CodeReviewContext): Promise<void> {
    for (const file of context.file_snapshots) {
      if (!file.after) continue;

      await this.analyzeErrorHandling(file.path, file.after);
      await this.analyzeNullSafety(file.path, file.after);
      await this.analyzeResourceManagement(file.path, file.after);
    }
  }

  // Security Analysis Methods
  private async analyzeForCommandInjection(filePath: string, content: string): Promise<void> {
    CODE_QUALITY_PATTERNS.COMMAND_INJECTION.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `cmd-injection-${filePath}-${line}`,
          engine: 'security',
          severity: 'BLOCKER',
          category: 'security',
          rule: 'CWE-78',
          title: 'Command Injection Vulnerability',
          description: 'Potential command injection through unsanitized input',
          file: filePath,
          line,
          impact: 'Allows arbitrary command execution on the system',
          effort: 'LOW',
          confidence: 90,
          cweId: 'CWE-78',
          pattern: match[0]
        });
      }
    });
  }

  private async analyzeForSqlInjection(filePath: string, content: string): Promise<void> {
    CODE_QUALITY_PATTERNS.SQL_INJECTION.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `sql-injection-${filePath}-${line}`,
          engine: 'security',
          severity: 'BLOCKER',
          category: 'security',
          rule: 'CWE-89',
          title: 'SQL Injection Vulnerability',
          description: 'Potential SQL injection through string concatenation',
          file: filePath,
          line,
          impact: 'Allows unauthorized database access and data manipulation',
          effort: 'MEDIUM',
          confidence: 85,
          cweId: 'CWE-89',
          pattern: match[0]
        });
      }
    });
  }

  private async analyzeForXss(filePath: string, content: string): Promise<void> {
    CODE_QUALITY_PATTERNS.XSS_PATTERNS.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `xss-${filePath}-${line}`,
          engine: 'security',
          severity: 'CRITICAL',
          category: 'security',
          rule: 'CWE-79',
          title: 'Cross-Site Scripting (XSS) Vulnerability',
          description: 'Potential XSS vulnerability through unescaped output',
          file: filePath,
          line,
          impact: 'Allows script injection and user data theft',
          effort: 'LOW',
          confidence: 80,
          cweId: 'CWE-79',
          pattern: match[0]
        });
      }
    });
  }

  private async analyzeForHardcodedSecrets(filePath: string, content: string): Promise<void> {
    const secretPattern = /(api[_-]?key|password|secret|token)\s*[:=]\s*['"][^'""]{8,}['"]/gi;
    let match;
    while ((match = secretPattern.exec(content)) !== null) {
      const line = this.getLineNumber(content, match.index);
      this.addFinding({
        id: `hardcoded-secret-${filePath}-${line}`,
        engine: 'security',
        severity: 'CRITICAL',
        category: 'security',
        rule: 'CWE-798',
        title: 'Hard-coded Credentials',
        description: 'Credentials or secrets should not be hard-coded',
        file: filePath,
        line,
        impact: 'Exposes sensitive credentials in source code',
        effort: 'LOW',
        confidence: 95,
        cweId: 'CWE-798',
        pattern: match[0].replace(/['"][^'"]*['"]/, '"[REDACTED]"')
      });
    }
  }

  private async analyzeForInsecureCrypto(filePath: string, content: string): Promise<void> {
    const weakCryptoPattern = /(md5|sha1|des|rc4)\s*\(/gi;
    let match;
    while ((match = weakCryptoPattern.exec(content)) !== null) {
      const line = this.getLineNumber(content, match.index);
      this.addFinding({
        id: `weak-crypto-${filePath}-${line}`,
        engine: 'security',
        severity: 'MAJOR',
        category: 'security',
        rule: 'CWE-326',
        title: 'Weak Cryptographic Algorithm',
        description: 'Use of cryptographically weak algorithm',
        file: filePath,
        line,
        impact: 'Compromised data integrity and confidentiality',
        effort: 'MEDIUM',
        confidence: 90,
        cweId: 'CWE-326',
        pattern: match[0]
      });
    }
  }

  // Performance Analysis Methods
  private async analyzeForNestedLoops(filePath: string, content: string): Promise<void> {
    CODE_QUALITY_PATTERNS.NESTED_LOOPS.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `nested-loops-${filePath}-${line}`,
          engine: 'performance',
          severity: 'MAJOR',
          category: 'performance',
          rule: 'complexity',
          title: 'Nested Loops Detected',
          description: 'Nested loops can lead to O(n²) complexity',
          file: filePath,
          line,
          impact: 'Potential performance degradation with large datasets',
          effort: 'MEDIUM',
          confidence: 85
        });
      }
    });
  }

  private async analyzeForBlockingIo(filePath: string, content: string): Promise<void> {
    CODE_QUALITY_PATTERNS.BLOCKING_IO.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `blocking-io-${filePath}-${line}`,
          engine: 'performance',
          severity: 'MAJOR',
          category: 'performance',
          rule: 'async-pattern',
          title: 'Blocking I/O Operation',
          description: 'Synchronous I/O blocks the event loop',
          file: filePath,
          line,
          impact: 'Degrades application responsiveness and scalability',
          effort: 'LOW',
          confidence: 95,
          pattern: match[0]
        });
      }
    });
  }

  private async analyzeForLargeObjects(filePath: string, content: string): Promise<void> {
    const largeObjectPattern = /JSON\.(parse|stringify)\([^)]{100,}\)/g;
    let match;
    while ((match = largeObjectPattern.exec(content)) !== null) {
      const line = this.getLineNumber(content, match.index);
      this.addFinding({
        id: `large-json-${filePath}-${line}`,
        engine: 'performance',
        severity: 'MINOR',
        category: 'performance',
        rule: 'memory-usage',
        title: 'Large JSON Operation',
        description: 'Large JSON operations can impact performance',
        file: filePath,
        line,
        impact: 'Potential memory usage and processing overhead',
        effort: 'MEDIUM',
        confidence: 70
      });
    }
  }

  private async analyzeForIneffientAlgorithms(filePath: string, content: string): Promise<void> {
    // Check for array.find() in loops
    const inefficientPattern = /for\s*\([^{]*\{[^}]*\.find\s*\(/g;
    let match;
    while ((match = inefficientPattern.exec(content)) !== null) {
      const line = this.getLineNumber(content, match.index);
      this.addFinding({
        id: `inefficient-search-${filePath}-${line}`,
        engine: 'performance',
        severity: 'MAJOR',
        category: 'performance',
        rule: 'algorithm-efficiency',
        title: 'Inefficient Search in Loop',
        description: 'Using find() inside loop creates O(n²) complexity',
        file: filePath,
        line,
        impact: 'Poor performance with large datasets',
        effort: 'MEDIUM',
        confidence: 80
      });
    }
  }

  // Maintainability Analysis Methods
  private async analyzeComplexity(filePath: string, content: string): Promise<void> {
    // Simple cyclomatic complexity approximation
    const complexityPattern = /(if|else if|while|for|catch|case|&&|\|\|)/g;
    const functions = content.match(/function\s+\w+[^{]*\{[^}]*\}|const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{[^}]*\}/g) || [];

    functions.forEach((func, index) => {
      const complexity = (func.match(complexityPattern) || []).length + 1;
      if (complexity > 10) {
        const line = this.getLineNumber(content, content.indexOf(func));
        this.addFinding({
          id: `high-complexity-${filePath}-${line}`,
          engine: 'maintainability',
          severity: complexity > 20 ? 'MAJOR' : 'MINOR',
          category: 'maintainability',
          rule: 'cyclomatic-complexity',
          title: `High Cyclomatic Complexity (${complexity})`,
          description: `Function has complexity of ${complexity}, consider refactoring`,
          file: filePath,
          line,
          impact: 'Reduces code readability and testability',
          effort: 'HIGH',
          confidence: 90
        });
      }
    });
  }

  private async analyzeDuplication(filePath: string, content: string): Promise<void> {
    // Simple duplication detection (lines with 50+ characters)
    const lines = content.split('\n').filter(line => line.trim().length > 50);
    const duplicates = new Map<string, number[]>();

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!duplicates.has(trimmed)) {
        duplicates.set(trimmed, []);
      }
      const lineNumbers = duplicates.get(trimmed);
      if (lineNumbers) lineNumbers.push(index + 1);
    });

    duplicates.forEach((lineNumbers, line) => {
      if (lineNumbers.length > 1) {
        this.addFinding({
          id: `duplication-${filePath}-${lineNumbers[0]}`,
          engine: 'maintainability',
          severity: 'MINOR',
          category: 'maintainability',
          rule: 'code-duplication',
          title: `Duplicated Code (${lineNumbers.length} instances)`,
          description: 'Consider extracting to a common function',
          file: filePath,
          line: lineNumbers[0],
          impact: 'Increases maintenance overhead',
          effort: 'MEDIUM',
          confidence: 85
        });
      }
    });
  }

  private async analyzeNaming(filePath: string, content: string): Promise<void> {
    // Check for single letter variables (except loop counters)
    const badNamingPattern = /(?:let|const|var)\s+([a-z])\s*[=;]/g;
    let match;
    while ((match = badNamingPattern.exec(content)) !== null) {
      if (!['i', 'j', 'k'].includes(match[1])) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `bad-naming-${filePath}-${line}`,
          engine: 'maintainability',
          severity: 'MINOR',
          category: 'maintainability',
          rule: 'naming-convention',
          title: 'Poor Variable Naming',
          description: 'Use descriptive variable names',
          file: filePath,
          line,
          impact: 'Reduces code readability',
          effort: 'LOW',
          confidence: 80
        });
      }
    }
  }

  private async analyzeMethodLength(filePath: string, content: string): Promise<void> {
    CODE_QUALITY_PATTERNS.LONG_METHODS.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index);
        const lineCount = match[0].split('\n').length;
        this.addFinding({
          id: `long-method-${filePath}-${line}`,
          engine: 'maintainability',
          severity: lineCount > 100 ? 'MAJOR' : 'MINOR',
          category: 'maintainability',
          rule: 'method-length',
          title: `Long Method (${lineCount} lines)`,
          description: 'Consider breaking down into smaller functions',
          file: filePath,
          line,
          impact: 'Reduces code readability and testability',
          effort: 'HIGH',
          confidence: 95
        });
      }
    });
  }

  // Reliability Analysis Methods
  private async analyzeErrorHandling(filePath: string, content: string): Promise<void> {
    // Check for functions without error handling
    const asyncFunctionPattern = /async\s+function[^{]*\{([^}]*)\}/g;
    let match;
    while ((match = asyncFunctionPattern.exec(content)) !== null) {
      if (!match[1].includes('try') && !match[1].includes('catch')) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `missing-error-handling-${filePath}-${line}`,
          engine: 'reliability',
          severity: 'MAJOR',
          category: 'reliability',
          rule: 'error-handling',
          title: 'Missing Error Handling',
          description: 'Async function lacks try-catch error handling',
          file: filePath,
          line,
          impact: 'Unhandled errors can crash the application',
          effort: 'LOW',
          confidence: 85
        });
      }
    }
  }

  private async analyzeNullSafety(filePath: string, content: string): Promise<void> {
    // Check for potential null pointer access
    const nullAccessPattern = /\w+\.\w+(?!\s*\?)/g;
    const hasNullChecks = content.includes('?.') || content.includes('null') || content.includes('undefined');

    if (!hasNullChecks) {
      let match;
      let count = 0;
      while ((match = nullAccessPattern.exec(content)) !== null && count < 3) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `null-safety-${filePath}-${line}`,
          engine: 'reliability',
          severity: 'MINOR',
          category: 'reliability',
          rule: 'null-safety',
          title: 'Potential Null Pointer Access',
          description: 'Consider adding null checks or optional chaining',
          file: filePath,
          line,
          impact: 'Potential runtime errors',
          effort: 'LOW',
          confidence: 60
        });
        count++;
      }
    }
  }

  private async analyzeResourceManagement(filePath: string, content: string): Promise<void> {
    // Check for unclosed resources
    const resourcePattern = /\.(open|connect|createReadStream|createWriteStream)\(/g;
    let match;
    while ((match = resourcePattern.exec(content)) !== null) {
      const afterMatch = content.slice(match.index);
      if (!afterMatch.includes('.close()') && !afterMatch.includes('.end()')) {
        const line = this.getLineNumber(content, match.index);
        this.addFinding({
          id: `resource-leak-${filePath}-${line}`,
          engine: 'reliability',
          severity: 'MAJOR',
          category: 'reliability',
          rule: 'resource-management',
          title: 'Potential Resource Leak',
          description: 'Resource opened but not explicitly closed',
          file: filePath,
          line,
          impact: 'Memory leaks and resource exhaustion',
          effort: 'LOW',
          confidence: 75
        });
      }
    }
  }

  // Utility Methods
  private addFinding(finding: QualityFinding): void {
    this.findings.push(finding);
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  private getSeverityWeight(severity: string): number {
    const weights = { 'BLOCKER': 5, 'CRITICAL': 4, 'MAJOR': 3, 'MINOR': 2, 'INFO': 1 };
    return weights[severity as keyof typeof weights] || 0;
  }

  private calculateQualityMetrics(): QualityMetrics {
    const blockerCount = this.findings.filter(f => f.severity === 'BLOCKER').length;
    const criticalCount = this.findings.filter(f => f.severity === 'CRITICAL').length;
    const majorCount = this.findings.filter(f => f.severity === 'MAJOR').length;

    return {
      securityRating: blockerCount > 0 ? 'F' : criticalCount > 0 ? 'D' : majorCount > 3 ? 'C' : 'A',
      maintainabilityRating: this.findings.filter(f => f.engine === 'maintainability').length > 10 ? 'C' : 'A',
      reliabilityRating: this.findings.filter(f => f.engine === 'reliability' && f.severity !== 'MINOR').length > 5 ? 'C' : 'A',
      technicalDebtRatio: Math.min(50, this.findings.length * 2),
      coveragePercent: 75, // Would need actual test coverage data
      duplicatedLinesPercent: this.findings.filter(f => f.rule === 'code-duplication').length * 0.5,
      complexityScore: 100 - Math.min(50, this.findings.filter(f => f.rule === 'cyclomatic-complexity').length * 5)
    };
  }

  private evaluateQualityGate(metrics: QualityMetrics): 'PASS' | 'FAIL' | 'WARNING' {
    const hasBlockers = this.findings.some(f => f.severity === 'BLOCKER');
    const hasCriticals = this.findings.some(f => f.severity === 'CRITICAL');

    if (hasBlockers) return 'FAIL';
    if (hasCriticals || metrics.technicalDebtRatio > 20) return 'WARNING';
    return 'PASS';
  }

  private calculateTechnicalDebt(): number {
    // Estimate hours based on severity and effort
    return this.findings.reduce((total, finding) => {
      const severityMultiplier = { 'BLOCKER': 8, 'CRITICAL': 4, 'MAJOR': 2, 'MINOR': 1, 'INFO': 0.5 };
      const effortMultiplier = { 'HIGH': 4, 'MEDIUM': 2, 'LOW': 1 };

      return total + (severityMultiplier[finding.severity] * effortMultiplier[finding.effort]);
    }, 0);
  }
}
