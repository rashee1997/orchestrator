import * as path from 'path';
import { GitService, GitContext, GitChange } from './GitService.js';

export type ContextLabel = 'Staged' | 'Unstaged';

export interface ContextSection {
  label: ContextLabel;
  context: GitContext;
}

export interface ChangeBuckets {
  staged: GitChange[];
  unstaged: GitChange[];
}

export function bucketChanges(sections: ContextSection[]): ChangeBuckets {
  const deduped = new Map<string, GitChange>();

  for (const { context } of sections) {
    for (const change of context.changes) {
      const key = `${change.changeType}:${change.filePath}`;
      if (!deduped.has(key)) {
        deduped.set(key, change);
      }
    }
  }

  const all = Array.from(deduped.values());
  return {
    staged: all.filter(change => change.changeType === 'staged'),
    unstaged: all.filter(change => change.changeType === 'unstaged')
  };
}

export async function collectContextSections(
  gitService: GitService,
  includeStaged: boolean,
  includeUnstaged: boolean
): Promise<ContextSection[]> {
  const sections: ContextSection[] = [];

  if (includeStaged) {
    const staged = await gitService.getCommitContext(true);
    if (staged.changes.length) {
      sections.push({ label: 'Staged', context: staged });
    }
  }

  if (includeUnstaged) {
    const unstaged = await gitService.getCommitContext(false);
    if (unstaged.changes.length) {
      const already = sections.some(section => section.label === 'Unstaged');
      if (!already) {
        sections.push({ label: 'Unstaged', context: unstaged });
      }
    }
  }

  return sections;
}

export function buildCombinedContextForAI(
  gitService: GitService,
  sections: ContextSection[],
  maxDiffSize: number = 200_000
): string {
  const header = '## Git Context for Commit Message Generation';
  const parts = sections.map(section => {
    const formatted = gitService.formatContextForAI(section.context);

    if (sections.length > 1 && formatted.includes(header)) {
      return formatted.replace(header, `## ${section.label} Changes`);
    }

    return formatted;
  });

  const combined = parts.join('\n\n');
  if (combined.length > maxDiffSize) {
    const start = combined.slice(0, maxDiffSize / 2);
    const end = combined.slice(-maxDiffSize / 2);
    return `${start}\n... [TRUNCATED DUE TO SIZE] ...\n${end}`;
  }

  return combined;
}

export function buildChangedFilesSection(sections: ContextSection[]): string {
  const { staged, unstaged } = bucketChanges(sections);
  if (staged.length === 0 && unstaged.length === 0) {
    return '';
  }

  const workingDirectory = sections[0]?.context.workingDirectory ?? process.cwd();
  let sectionText = '## 📝 Changed Files\n\n';

  if (staged.length > 0) {
    sectionText += '**Staged**\n';
    for (const change of staged) {
      const fileName = path.basename(change.filePath);
      const relativePath = path.relative(workingDirectory, change.filePath);
      sectionText += `- **${change.status}:** \`${fileName}\` (\`${relativePath}\`)\n`;
    }
    sectionText += '\n';
  }

  if (unstaged.length > 0) {
    sectionText += '**Unstaged**\n';
    for (const change of unstaged) {
      const fileName = path.basename(change.filePath);
      const relativePath = path.relative(workingDirectory, change.filePath);
      sectionText += `- **${change.status}:** \`${fileName}\` (\`${relativePath}\`)\n`;
    }
    sectionText += '\n';
  }

  return sectionText;
}

export function parseFileArguments(files?: string | string[]): string[] {
  if (!files) {
    return [];
  }

  const values = Array.isArray(files) ? files : files.split(/\r?\n|,/);
  return values
    .map(value => value.trim())
    .filter(value => value.length > 0);
}
