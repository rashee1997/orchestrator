export const CODE_QUALITY_PATTERNS = {
  // Security patterns
  COMMAND_INJECTION: [
    /execSync\s*\([^)]*\$\{[^}]*\}/g,
    /spawn\s*\([^)]*\+[^)]*\)/g,
    /`[^`]*\$\{[^}]*\}[^`]*/g,
  ],

  SQL_INJECTION: [
    /query\s*\([^)]*\+[^)]*\)/g,
    /SELECT[^;]*\$\{[^}]*\}/gi,
    /INSERT[^;]*\+[^;]*VALUES/gi,
  ],

  XSS_PATTERNS: [
    /innerHTML\s*=\s*[^;]*\+/g,
    /document\.write\s*\([^)]*\+/g,
    /outerHTML\s*\+=\s*[^;]*\$/g,
  ],

  // Performance patterns
  NESTED_LOOPS: [
    /for\s*\([^{]*\{[^}]*for\s*\(/g,
    /while\s*\([^{]*\{[^}]*while\s*\(/g,
  ],

  BLOCKING_IO: [
    /readFileSync|writeFileSync|execSync|statSync/g,
    /\.sync\(\)/g,
  ],

  // Maintainability patterns
  LONG_METHODS: [
    /function\s+\w+[^{]*\{[\s\S]{1500,}\}/g,
    /\w+\s*=>\s*\{[\s\S]{1500,}\}/g,
  ],

  MAGIC_NUMBERS: [/([^\.\w])\d{2,}(?![\.\w])/g],
} as const;

export interface QualityMetrics {
  securityRating: 'A' | 'B' | 'C' | 'D' | 'F';
  maintainabilityRating: 'A' | 'B' | 'C' | 'D' | 'F';
  reliabilityRating: 'A' | 'B' | 'C' | 'D' | 'F';
  technicalDebtRatio: number;
  coveragePercent: number;
  duplicatedLinesPercent: number;
  complexityScore: number;
}

