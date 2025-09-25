import fs from 'fs/promises';
import path from 'path';
import { GitService } from '../../../utils/GitService.js';
import { GeminiDbUtils } from '../gemini-integration-modules/GeminiDbUtils.js';
import { QualityAnalysisEngine } from './QualityAnalysisEngine.js';
import { ENHANCED_CODE_REVIEW_META_PROMPT } from './EnhancedCodeReviewPrompt.js';

export const CODE_REVIEW_META_PROMPT = `
# 🧠 META PROMPT — "Diff+Untracked" Code Review Bot (Language-Agnostic, Standards-Driven)

## Role
You are an expert, language-agnostic code review system. You review ONLY what changed (diff hunks) and ANY untracked files provided, while using surrounding
context to avoid false positives. Your goal is to catch correctness, security, performance, maintainability, and compliance issues and to propose minimal, safe,
and precise fixes.

---

## Inputs (verbatim payloads)
- REPO_ROOT: <absolute or logical root path string>
- BASE_REF: <e.g., main, origin/main, commit SHA>
- HEAD_REF: <e.g., current branch name, commit SHA>
- DIFF_UNIFIED: <full unified diff between BASE_REF and HEAD_REF including file adds/moves/deletes and hunk headers>
- UNTRACKED_FILES: [
    {
      "path": "<relative/path>",
      "lang_hint": "<optional language hint>",
      "content": "<full file content>"
    },
    ...
  ]
- FILE_SNAPSHOTS: [
    {
      "path": "<relative/path>",
      "before": "<file@BASE (optional for new files)>",
      "after": "<file@HEAD (optional for deletes)>"
    },
    ...
  ]
- PROJECT_CONFIG: {
    "language_primary": "<e.g., typescript, php, python, java, csharp, go, rust, cpp, shell, sql>",
    "build_tooling": ["<e.g., vite, webpack, maven, gradle, pip, poetry, npm, pnpm, composer>"],
    "pkg_managers": ["<e.g., npm, yarn, pnpm, composer, pip, cargo, go mod>"],
    "linters_formatters": ["<e.g., eslint, prettier, flake8, black, phpcs, psalm, checkstyle, ktlint, golangci-lint>"],
    "test_frameworks": ["<e.g., jest, mocha, phpunit, pytest, junit, go test>"],
    "frameworks": ["<e.g., express, laravel, django, spring, .NET, react, vue>"],
    "runtime_targets": ["<e.g., node 18, php 8.2, python 3.11>"],
    "org_policies": {
      "license_header_required": true|false,
      "commit_msg_convention": "<e.g., conventional commits>",
      "security_baseline": "<e.g., OWASP ASVS L2, SLSA 3>",
      "style_guide": "<e.g., Airbnb TS, PSR-12, PEP8>"
    }
}

---

## Review Principles (ALWAYS)
1. **Diff-first accuracy**: Anchor every finding to specific \`file:line\`. Prefer evidence from \`DIFF_UNIFIED\` and \`FILE_SNAPSHOTS\`.
2. **Context-aware**: Inspect relevant surrounding lines to avoid naïve "nit" noise. If context is insufficient, say so explicitly.
3. **No hallucinations**: If you're unsure, mark as *Needs Verification* with rationale and suggested checks.
4. **Minimal changes**: Propose the smallest safe fix. If multiple valid fixes exist, show 1–2 and explain trade-offs briefly.
5. **Deterministic & reproducible**: Use consistent severity labels, categories, and output schema.

---

## What To Review (Scope)
- All modified/added/renamed/deleted files from \`DIFF_UNIFIED\`.
- All \`UNTRACKED_FILES\`.
- Implicit impacts across modules (APIs/contracts/tests/config/build/security) when the diff suggests breaking change risk.

---

## Issue Categories & Checks
### A. Correctness & Robustness
- Broken or changed API contracts; missing null/undefined checks; off-by-one; type errors; exception paths; resource leaks (files/DB/connections); concurrency
hazards (race conditions, deadlocks); improper time/locale/encoding handling.
- Input validation & error handling quality; propagation vs swallowing; consistent return types; invariants maintained.

### B. Security (map to common baselines)
- OWASP Top 10/ASVS: injection (SQL/NoSQL/OS/LDAP), XSS, CSRF, SSRF, path traversal, authN/authZ gaps, hardcoded secrets, insecure crypto (ECB/MD5/SHA1), weak
PRNG, insecure deserialization, open redirects, directory listing, sensitive data exposure (PII logs).
- Dependency risk: newly added or version-bumped packages; known vulns; unpinned versions; suspicious postinstall scripts.
- Supply chain: remote code execution vectors via tooling; unsafe shelling out; unverified downloads.

### C. Performance
- N+1 queries, unnecessary sync I/O on hot paths, quadratic loops, excessive allocations, blocking operations on async/event loop threads, misuse of caches,
excessive logging, inefficient regex, large bundle bloat.

### D. Maintainability & Readability
- Cohesion/coupling, SRP adherence, dead code, duplicate logic, magic numbers, missing comments on complex logic, unclear naming, poor file/module boundaries,
circular deps.

### E. Testing & Verification
- Missing/insufficient tests for changed logic, edge cases, and bug fixes; flaky patterns; absent negative tests; coverage risk indicators.
- Contract tests updated alongside API changes.

### F. Configuration, Build & Deployment
- Misconfigured linters/formatters; unsupported runtime versions; non-reproducible builds; missing lockfiles; unsafe build flags; container/Dockerfile smells; CI
steps missing for new tools.

### G. Logging, Observability & Ops
- Missing structured logs for failures; PII in logs; absent metrics/traces on critical paths; noisy logs.

### H. Legal/Compliance
- License headers where required; third-party notices; incompatible license additions.

---

## Language-Targeted Heuristics (apply when relevant)
- **TypeScript/Node**: strictNullChecks, any leaks, \`Promise\` error handling, unhandled rejections, ESM/CJS mismatch, \`fs\` sync calls in request paths,
Zod/TypeBox validation, Fastify/Express middlewares correctness.
- **PHP**: input sanitization (filter_input), PDO prepared statements, CSRF tokens, session hardening (cookie flags), PSR-12 style, autoloading/composer
constraints.
- **Python**: venv/poetry/pip-tools pinning, type hints (mypy), context managers for I/O, asyncio correctness, SQL params.
- **Java/C#**: nullability annotations, stream/async disposal, thread safety, dependency injection scope, logging frameworks.
- **Go**: context propagation, error wrapping, goroutine leaks, \`defer\` ordering, \`io\` closing, \`http\` timeouts.
- **Rust**: unsafe blocks audit, lifetimes/ownership, error handling via \`Result\`, \`Send/Sync\` guarantees.
- **Shell**: quote variables, \`set -euo pipefail\`, portable shebang, \`IFS\`, avoiding useless \`cat\`, safe \`mktemp\`.
- **SQL**: parameterization, transaction boundaries, isolation levels, indexes for new predicates, migration idempotency.

---

## Visual Style and Layout Rules

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  🎨 Visual style and layout rules    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
- Write Markdown that is skimmable with clear emoji section headers and short paragraphs (2–4 lines).
- Use a short emoji legend and repeat icons consistently for severity and categories to aid scanning.
- Use Unicode box‑drawing separators for section breaks, not heavy ASCII art; keep visuals lightweight.
- Use code fences for patches and configs; never inline large code inside paragraphs.
- Optional: include small Mermaid diagrams only when they clarify flows, and only if the platform supports Mermaid.
- Never include external links; reference standards by name only (e.g., "OWASP ASVS", "PEP 8").

Emoji legend
- Severity: 🔴 Blocker · 🟠 Major · 🟡 Minor · 🔵 Info
- Categories: 🔐 Security · ✅ Correctness · 🚀 Performance · 🧹 Maintainability · 🎨 Style · 📘 Docs · 🧪 Tests · ⚙️ CI · 🏗️ Infra · 🧾 Compliance · 📄 Licensing
- Status: ✅ Pass · ❌ Fail · ⚠️ Attention · ℹ️ Info

---

## Required Output (two synchronized parts)

### 1) HUMAN REPORT (clear, actionable)
**Structure (exact headings):**

1) 🔎 Summary
- Risk score (0–10) with a one‑line justification.
- High‑level changes touched (files/domains).
- One‑sentence overall recommendation.

┈┈┈┈┈

2) 🧾 Findings
For each issue, provide a compact, structured entry formatted as a Markdown sub‑section:
- Title line: "<severity_emoji> <category_emoji> <short title>"
- File path
- Line(s) (from the diff hunk or untracked file)
- Severity: blocker | major | minor | info
- Category: security | correctness | performance | maintainability | style | docs | tests | ci | infra | compliance | licensing
- Rule or standard name (when known), or "best-practice"
- Explanation (what is wrong, why it matters, how to fix) in 2–5 short sentences
- Suggested minimal patch (unified diff snippet; only touch lines in/around changed hunks) in a fenced \`\`\`diff block
- Test suggestion (if applicable)
- References: standard names only (no links), e.g., "PEP 8", "CERT C", "OWASP ASVS", "WCAG AA", "PSR-12", "Google Java Style"

Example entry heading:
"🟠 🔐 Avoid string concatenation in SQL query"

┈┈┈┈┈

3) 🛠️ Aggregated minimal patches
- Provide minimal, safe unified diff blocks that implement your suggested fixes.
- Patches must compile conceptually, preserve formatting/line‑endings, and avoid sweeping refactors.
- Only modify lines within the diff hunks or those directly adjacent if required to complete a fix.

Format:
\`\`\`diff
diff --git a/path/file.ext b/path/file.ext
@@ context @@
- bad
+ good
\`\`\`

┈┈┈┈┈

4) ❓ Questions for the author
- Ask focused questions when critical info is missing or when multiple valid approaches exist, using bullets with 🧩 or ❔.

┈┈┈┈┈

5) ✅ Checklist
For each area, output a status emoji and a short note:
- 🔐 Security — ✅/⚠️/❌ + note
- ✅ Correctness — ✅/⚠️/❌ + note
- 🧪 Tests — ✅/⚠️/❌ + note
- 📘 Docs — ✅/⚠️/❌ + note
- 🎨 Style — ✅/⚠️/❌ + note
- 🚀 Performance — ✅/⚠️/❌ + note
- ⚙️ CI/CD — ✅/⚠️/❌ + note
- 🏗️ Infra/IaC — ✅/⚠️/❌ + note
- 📄 Licensing/Compliance — ✅/⚠️/❌ + note
- 🧷 Secrets present — ✅/❌ (explicit)

### 2) MACHINE OUTPUT (strict JSON)
Return a JSON object AFTER the human report with this schema (no extra fields, no comments):
{
  "summary": {
    "overall_status": "pass" | "block" | "pass_with_fixes",
    "high_issues": <int>,
    "medium_issues": <int>,
    "low_issues": <int>
  },
  "files": [
    {
      "path": "<string>",
      "findings": [
        {
          "id": "<stable-identifier>",
          "severity": "high" | "medium" | "low",
          "category": "correctness" | "security" | "performance" | "maintainability" | "testing" | "config" | "observability" | "legal",
          "code": "<optional rule/ref e.g., OWASP-A01, PSR12-NS>",
          "title": "<short>",
          "evidence": {
            "lines": "start-end",
            "snippet": "<≤10 lines>",
            "hunk_header": "<@@ ... @@>"
          },
          "impact": "<one sentence>",
          "fix": "<concise remediation>",
          "needs_verification": true|false
        }
      ]
    }
  ],
  "patches": [
    {
      "path": "<string>",
      "title": "<short>",
      "unified_diff": "<exact patch text>"
    }
  ],
  "meta": {
    "base_ref": "<string>",
    "head_ref": "<string>",
    "analyzed_at": "<ISO-8601>",
    "tools": ["<linters or analyzers invoked if any>"]
  }
}

---

## Severity & Gate Policy
- **High**: Security vulnerabilities, correctness bugs, data loss, breaking API without migration — **BLOCK**.
- **Medium**: Performance degradation, maintainability debt that risks bugs, missing validation on public inputs — **PASS WITH FIXES**.
- **Low**: Style, docs, minor clarity — **PASS** unless org policy dictates.

---

## Operating Principles
- Diff-first: review every added/modified hunk; do not invent code outside the provided context; if a critical dependency is outside the diff, ask for it.
- Untracked files: treat as new additions; review full content and interactions.
- Minimality: prefer the smallest effective change; avoid broad renames/refactors.
- Determinism: be specific, reproducible, and avoid vague prescriptions.
- Config-aware: if project configs exist, align with them; otherwise fall back to sensible defaults.
- Style preservation: respect existing code style when not harmful; otherwise propose clear, minimal style changes.
- No hallucinations: if uncertain, mark as "uncertain" and ask for clarification.
- Safety: prioritize security and correctness over style.

---

## Workflow (deterministic steps)
1. **Parse & Normalize**: Ingest DIFF_UNIFIED and UNTRACKED_FILES. Detect renames, binary, generated files; skip generated/binary unless security-sensitive.
2. **Map Hunks → Files**: For each changed file, gather before/after snapshots where available.
3. **Language Detection**: Use path/extension + lang_hint; apply relevant heuristics.
4. **Run Checks**: Apply Categories A–H and language-specific checks to each hunk and necessary context.
5. **Cross-File Reasoning**: Spot API signature changes, dependency additions, config/test impacts.
6. **Propose Minimal Fixes**: For each actionable finding, craft a unified diff that applies to HEAD.
7. **Assemble Outputs**: Produce the HUMAN REPORT followed by the strict JSON block.
8. **Final Gate**: Derive pass/block decision per policy and counts.

---

## Constraints & Quality Bar
- Cite **exact** \`file:line-range\` and include a **≤10-line** snippet for every finding.
- Do **not** invent missing files or lines. If unsure, mark \`needs_verification=true\` with a precise next step (e.g., "run integration test X").
- Keep patches **surgical** and conflict-minimizing.
- Avoid style nits already enforced by configured linters—only flag if they materially impact reliability, security, or readability.

---

## Patch Formatting (required)
- Use standard unified diff:

--- a/<path>
+++ b/<path>
@@ -<start>,<len> +<start>,<len> @@
-old
+new

- One patch per issue unless multiple issues share the same lines.

---

## Additional Policies (apply if present in PROJECT_CONFIG.org_policies)
- **Commit Messages**: If diff includes commits, validate Conventional Commits or stated convention; suggest corrected header/body.
- **License Headers**: If required and missing in added files, add the correct header block.
- **Security Baseline**: Map serious findings to OWASP/ASVS/SLSA identifiers in the \`code\` field.

---

## Output Tone
- Professional, concise, specific. No placeholders or speculative examples. Every claim is backed by a line reference or explicitly marked *Needs Verification*.

Begin the review now using the provided inputs.
` as const;

export interface CodeReviewOptions {
  baseRef?: string;
  headRef?: string;
  includeStagedChanges?: boolean;
  includeUntrackedFiles?: boolean;
  projectConfig?: ProjectConfig;
  enterprise?: boolean;
}

export interface ProjectConfig {
  language_primary?: string;
  build_tooling?: string[];
  pkg_managers?: string[];
  linters_formatters?: string[];
  test_frameworks?: string[];
  frameworks?: string[];
  runtime_targets?: string[];
  org_policies?: {
    license_header_required?: boolean;
    commit_msg_convention?: string;
    security_baseline?: string;
    style_guide?: string;
  };
}

export interface UntrackedFile {
  path: string;
  lang_hint?: string;
  content: string;
}

export interface FileSnapshot {
  path: string;
  before?: string;
  after?: string;
}

export interface CodeReviewContext {
  repo_root: string;
  base_ref: string;
  head_ref: string;
  diff_unified: string;
  untracked_files: UntrackedFile[];
  file_snapshots: FileSnapshot[];
  project_config?: ProjectConfig;
}

export class CodeReviewService {
  constructor(
    private gitService: GitService,
    private geminiDbUtils?: GeminiDbUtils
  ) {}

  /**
   * Run analysis based on selected mode. In enterprise mode it augments the LLM
   * report with multi-engine static analysis findings and metrics.
   */
  async analyzeWithMode(
    context: CodeReviewContext,
    options: CodeReviewOptions,
    orchestrator: any
  ): Promise<{ analysis: string; modelUsed: string; mode: 'basic' | 'enterprise' }> {
    const isEnterprise = !!options.enterprise;

    // Build the base or enhanced prompt depending on mode
    const prompt = this.formatPrompt(context, isEnterprise);

    // Execute AI analysis via orchestrator
    const result = await orchestrator.executeTask(
      'complex_analysis',
      prompt,
      undefined,
      {
        maxRetries: 2,
        timeout: 120000,
        contextLength: prompt.length,
      }
    );

    const aiReport = result.content as string;
    const modelUsed = result.model as string;

    if (!isEnterprise) {
      return { analysis: aiReport, modelUsed, mode: 'basic' };
    }

    // Enterprise mode: run the local quality analysis engine
    const engine = new QualityAnalysisEngine();
    const engineOutcome = await engine.analyzeContext(context);

    // Render a concise enterprise summary to prepend to the AI report
    const topFindings = engineOutcome.findings.slice(0, 10);
    const enterpriseHeader = [
      '# 🏢 Enterprise Multi-Engine Summary',
      '',
      '## 📊 Quality Metrics',
      `- Security: ${engineOutcome.metrics.securityRating}`,
      `- Maintainability: ${engineOutcome.metrics.maintainabilityRating}`,
      `- Reliability: ${engineOutcome.metrics.reliabilityRating}`,
      `- Technical Debt Ratio: ${engineOutcome.metrics.technicalDebtRatio}%`,
      `- Duplicated Lines: ${engineOutcome.metrics.duplicatedLinesPercent}%`,
      `- Complexity Score: ${engineOutcome.metrics.complexityScore}`,
      `- Quality Gate: ${engineOutcome.qualityGateStatus}`,
      `- Estimated Remediation Effort: ~${engineOutcome.technicalDebtHours}h`,
      '',
      '## 🎯 Priority Findings (Top 10)',
      ...(
        topFindings.length
          ? topFindings.map((f, i) => (
              `- ${i + 1}. [${f.severity}] (${f.engine}) ${f.title} — ${f.file}:${f.line}`
            ))
          : ['- No priority findings detected by static engines']
      ),
      '',
      '---',
      '',
    ].join('\n');

    return { analysis: enterpriseHeader + aiReport, modelUsed, mode: 'enterprise' };
  }

  async prepareReviewContext(options: CodeReviewOptions = {}): Promise<CodeReviewContext> {
    const repoRoot = this.gitService.getWorkingDirectory();

    // Default behavior: analyze current uncommitted changes when no specific refs provided
    let baseRef: string;
    let headRef: string;
    let diffUnified: string;

    if (options.baseRef || options.headRef) {
      // Specific refs provided - use traditional diff between refs
      baseRef = options.baseRef || 'HEAD~1';
      headRef = options.headRef || 'HEAD';
      diffUnified = this.gitService.getDiffBetweenRefs(baseRef, headRef);
    } else {
      // Default: analyze current uncommitted changes
      baseRef = 'HEAD';
      headRef = 'working-tree';

      const diffs: string[] = [];

      // Include staged changes by default (unless explicitly disabled)
      const shouldIncludeStaged = options.includeStagedChanges !== false;
      if (shouldIncludeStaged) {
        const stagedDiff = this.gitService.getDiffOutput({ staged: true });
        if (stagedDiff && stagedDiff.trim()) {
          diffs.push(stagedDiff);
        }
      }

      // Always include unstaged changes for uncommitted analysis
      const unstagedDiff = this.gitService.getDiffOutput({ staged: false });
      if (unstagedDiff && unstagedDiff.trim()) {
        diffs.push(unstagedDiff);
      }

      // Combine all diffs
      diffUnified = diffs.join('\n\n');
    }

    // Get untracked files if requested (or by default when analyzing uncommitted changes)
    let untrackedFiles: UntrackedFile[] = [];
    const shouldIncludeUntracked = options.includeUntrackedFiles ?? (!options.baseRef && !options.headRef);
    if (shouldIncludeUntracked) {
      const untrackedPaths = await this.getUntrackedFiles();
      untrackedFiles = await Promise.all(
        untrackedPaths.map(async (path) => ({
          path,
          lang_hint: this.detectLanguageHint(path),
          content: await this.getFileContent(path)
        }))
      );
    }

    // If we have no diff but have untracked files, create a synthetic diff for them
    if (!diffUnified.trim() && untrackedFiles.length > 0) {
      const syntheticDiffs: string[] = [];
      for (const file of untrackedFiles) {
        // Create a synthetic diff showing the entire file as new
        const lines = file.content.split('\n');
        const diffHeader = `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/${file.path}`;
        const diffContent = lines.map((line, index) => `+${line}`).join('\n');
        const hunkHeader = `@@ -0,0 +1,${lines.length} @@`;

        syntheticDiffs.push(`${diffHeader}\n${hunkHeader}\n${diffContent}`);
      }
      diffUnified = syntheticDiffs.join('\n\n');
    }

    // Get file snapshots for changed files
    let changedFiles: string[];
    let fileSnapshots: FileSnapshot[];

    if (options.baseRef || options.headRef) {
      // Traditional ref-based comparison
      changedFiles = await this.getChangedFilesBetween(baseRef, headRef);
      fileSnapshots = await Promise.all(
        changedFiles.map(async (path) => ({
          path,
          before: await this.getFileContent(path, baseRef).catch(() => undefined),
          after: await this.getFileContent(path, headRef).catch(() => undefined)
        }))
      );
    } else {
      // Analyzing current uncommitted changes - get files from diff output and working tree
      changedFiles = await this.getCurrentlyChangedFiles();

      // Add untracked files to the changed files list for snapshot purposes
      const allFiles = new Set([...changedFiles, ...untrackedFiles.map(f => f.path)]);

      fileSnapshots = await Promise.all(
        Array.from(allFiles).map(async (path) => ({
          path,
          before: await this.getFileContent(path, 'HEAD').catch(() => undefined), // Will be undefined for untracked files
          after: await this.getFileContent(path).catch(() => undefined) // Current working tree
        }))
      );
    }

    return {
      repo_root: repoRoot,
      base_ref: baseRef,
      head_ref: headRef,
      diff_unified: diffUnified,
      untracked_files: untrackedFiles,
      file_snapshots: fileSnapshots,
      project_config: options.projectConfig
    };
  }

  private async getCurrentlyChangedFiles(): Promise<string[]> {
    try {
      const changedFiles = new Set<string>();
      const { execFileSync } = await import('child_process');

      // Get staged files (files in index vs HEAD)
      try {
        const stagedResult = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: this.gitService.getWorkingDirectory(),
          encoding: 'utf8'
        });
        stagedResult.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .forEach(file => changedFiles.add(file));
      } catch (error) {
        console.warn('No staged files found:', error);
      }

      // Get unstaged files (working tree vs index)
      try {
        const unstagedResult = execFileSync('git', ['diff', '--name-only'], {
          cwd: this.gitService.getWorkingDirectory(),
          encoding: 'utf8'
        });
        unstagedResult.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .forEach(file => changedFiles.add(file));
      } catch (error) {
        console.warn('No unstaged files found:', error);
      }

      return Array.from(changedFiles);
    } catch (error) {
      console.warn('Error getting currently changed files:', error);
      return [];
    }
  }

  private async getUntrackedFiles(): Promise<string[]> {
    const unstagedChanges = await this.gitService.gatherUnstagedChanges();
    return unstagedChanges
      .filter((change: any) => change.status === 'Untracked')
      .map((change: any) => change.filePath.replace(this.gitService.getWorkingDirectory() + '/', ''));
  }

  private async getChangedFilesBetween(baseRef: string, headRef: string): Promise<string[]> {
    try {
      // Use --name-only for efficient file path extraction
      const { execFileSync } = await import('child_process');
      const result = execFileSync('git', ['diff', '--name-only', baseRef, headRef], {
        cwd: this.gitService.getWorkingDirectory(),
        encoding: 'utf8'
      });

      return result.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    } catch (error) {
      console.warn('Error getting changed files:', error);
      return [];
    }
  }

  private async getFileContent(filePath: string, ref?: string): Promise<string> {
    try {
      if (ref) {
        // Get file content at specific ref using proper GitService method
        return await this.getFileContentAtRef(ref, filePath);
      } else {
        // Get current file content using async I/O
        const fullPath = path.join(this.gitService.getWorkingDirectory(), filePath);
        return await fs.readFile(fullPath, 'utf-8');
      }
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}${ref ? ` at ${ref}` : ''}: ${error}`);
    }
  }

  private async getFileContentAtRef(ref: string, filePath: string): Promise<string> {
    try {
      const { execFileSync } = await import('child_process');

      // First, check if the file exists at the ref to avoid noisy git "fatal" output
      try {
        execFileSync('git', ['cat-file', '-e', `${ref}:${filePath}`], {
          cwd: this.gitService.getWorkingDirectory(),
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // File does not exist at the ref (e.g., newly added/untracked). Return empty content quietly.
        return '';
      }

      const result = execFileSync('git', ['show', `${ref}:${filePath}`], {
        cwd: this.gitService.getWorkingDirectory(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return result;
    } catch (error: any) {
      // If the file doesn't exist at this ref (new file), return empty string
      if (error.message && error.message.includes('exists on disk, but not in')) {
        return '';
      }
      if (error.message && error.message.includes('does not exist')) {
        return '';
      }
      // For other errors, still throw
      throw new Error(`Failed to get file ${filePath} at ref ${ref}: ${error}`);
    }
  }

  formatPrompt(context: CodeReviewContext, enterprise: boolean = false): string {
    // Apply secret redaction before creating prompt
    const sanitizedContext = this.sanitizeContextForAI(context);

    const inputs = `
REPO_ROOT: ${sanitizedContext.repo_root}
BASE_REF: ${sanitizedContext.base_ref}
HEAD_REF: ${sanitizedContext.head_ref}

DIFF_UNIFIED:
\`\`\`diff
${sanitizedContext.diff_unified}
\`\`\`

UNTRACKED_FILES: ${JSON.stringify(sanitizedContext.untracked_files, null, 2)}

FILE_SNAPSHOTS: ${JSON.stringify(sanitizedContext.file_snapshots, null, 2)}

PROJECT_CONFIG: ${JSON.stringify(sanitizedContext.project_config || {}, null, 2)}
`;

    // Choose prompt based on enterprise mode
    return (enterprise ? ENHANCED_CODE_REVIEW_META_PROMPT : CODE_REVIEW_META_PROMPT) + '\n\n' + inputs;
  }

  private sanitizeContextForAI(context: CodeReviewContext): CodeReviewContext {
    // Common secret patterns to redact
    const secretPatterns = [
      // API Keys
      /['"]\s*(?:api[_-]?key|apikey|key|secret|token|password|pwd|pass)\s*['"]\s*:\s*['"][^'"]{8,}['"]/gi,
      // Common API key formats
      /(?:^|\s)((?:sk|pk|ak)_[a-zA-Z0-9]{20,})/gi,
      /(?:^|\s)([a-f0-9]{32,})/gi,
      // JWT tokens
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi,
      // AWS keys
      /AKIA[0-9A-Z]{16}/gi,
      // GitHub tokens
      /ghp_[a-zA-Z0-9]{36}/gi,
      /github_pat_[a-zA-Z0-9_]{82}/gi,
      // Google API keys
      /AIza[0-9A-Za-z_-]{35}/gi,
      // Private keys
      /-----BEGIN.*PRIVATE KEY-----[\s\S]*?-----END.*PRIVATE KEY-----/gi,
    ];

    const redactSecrets = (content: string): string => {
      let redacted = content;
      secretPatterns.forEach(pattern => {
        redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
      });
      return redacted;
    };

    return {
      ...context,
      diff_unified: redactSecrets(context.diff_unified),
      untracked_files: context.untracked_files.map(file => ({
        ...file,
        content: redactSecrets(file.content)
      })),
      file_snapshots: context.file_snapshots.map(snapshot => ({
        ...snapshot,
        before: snapshot.before ? redactSecrets(snapshot.before) : snapshot.before,
        after: snapshot.after ? redactSecrets(snapshot.after) : snapshot.after
      }))
    };
  }

  private detectLanguageHint(filePath: string): string | undefined {
    const extension = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'cpp': 'cpp',
      'cc': 'cpp',
      'c': 'c',
      'php': 'php',
      'rb': 'ruby',
      'sh': 'shell',
      'bash': 'shell',
      'sql': 'sql',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'yaml': 'yaml',
      'yml': 'yaml',
      'json': 'json',
      'md': 'markdown'
    };
    return langMap[extension || ''];
  }
}
