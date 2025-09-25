export type ReviewSeverity = 'high' | 'medium' | 'low';

export type ReviewCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'testing'
  | 'config'
  | 'observability'
  | 'legal';

export type ReviewStatus = 'pass' | 'block' | 'pass_with_fixes';

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  code?: string;
  title: string;
  evidence: {
    lines: string;
    snippet: string;
    hunk_header: string;
  };
  impact: string;
  fix: string;
  needs_verification: boolean;
}

export interface ReviewFileResult {
  path: string;
  findings: ReviewFinding[];
}

export interface ReviewPatch {
  path: string;
  title: string;
  unified_diff: string;
}

export interface ReviewSummary {
  overall_status: ReviewStatus;
  high_issues: number;
  medium_issues: number;
  low_issues: number;
}

export interface ReviewResult {
  summary: ReviewSummary;
  files: ReviewFileResult[];
  patches: ReviewPatch[];
  meta: {
    base_ref: string;
    head_ref: string;
    analyzed_at: string;
    tools: string[];
  };
}

export interface GitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

export interface GitDiffFile {
  oldPath: string;
  newPath: string;
  hunks: GitDiffHunk[];
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

export interface LanguageInfo {
  language: string;
  framework?: string;
  confidence: number;
}
