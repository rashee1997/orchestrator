import { GitDiffFile, GitDiffHunk } from './types.js';

export class DiffParser {
  static parse(diffText: string): GitDiffFile[] {
    const files: GitDiffFile[] = [];
    const lines = diffText.split('\n');
    let currentFile: GitDiffFile | null = null;
    let currentHunk: GitDiffHunk | null = null;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Parse file header
      if (line.startsWith('diff --git ')) {
        if (currentFile && currentHunk) {
          currentFile.hunks.push(currentHunk);
        }
        if (currentFile) {
          files.push(currentFile);
        }

        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (match) {
          currentFile = {
            oldPath: match[1],
            newPath: match[2],
            hunks: [],
            isNew: false,
            isDeleted: false,
            isRenamed: match[1] !== match[2]
          };
        }
        currentHunk = null;
      }
      // Parse file mode changes
      else if (line.startsWith('new file mode')) {
        if (currentFile) currentFile.isNew = true;
      }
      else if (line.startsWith('deleted file mode')) {
        if (currentFile) currentFile.isDeleted = true;
      }
      // Parse hunk header
      else if (line.startsWith('@@')) {
        if (currentFile && currentHunk) {
          currentFile.hunks.push(currentHunk);
        }

        const hunkMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
        if (hunkMatch) {
          currentHunk = {
            oldStart: parseInt(hunkMatch[1]),
            oldLines: parseInt(hunkMatch[2] || '1'),
            newStart: parseInt(hunkMatch[3]),
            newLines: parseInt(hunkMatch[4] || '1'),
            header: line,
            lines: []
          };
        }
      }
      // Parse hunk content
      else if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
        currentHunk.lines.push(line);
      }

      i++;
    }

    // Add the last hunk and file
    if (currentFile && currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    if (currentFile) {
      files.push(currentFile);
    }

    return files;
  }

  static getChangedLines(hunk: GitDiffHunk): { added: number[], removed: number[] } {
    const added: number[] = [];
    const removed: number[] = [];
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added.push(newLineNum);
        newLineNum++;
      } else if (line.startsWith('-')) {
        removed.push(oldLineNum);
        oldLineNum++;
      } else {
        oldLineNum++;
        newLineNum++;
      }
    }

    return { added, removed };
  }

  static extractSnippet(hunk: GitDiffHunk, contextLines = 3): string {
    const lines = hunk.lines.slice(0, Math.min(hunk.lines.length, contextLines * 2 + 1));
    return lines.join('\n');
  }
}
