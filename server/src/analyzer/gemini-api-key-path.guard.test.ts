import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Gemini API key path guard', () => {
  it('scans repo for stale Gemini API key paths and ensures new path is correct', () => {
    /* The Gemini API key location moved from Account → Server configuration
       to Admin → Model Manager (2026-07-15). This guard ensures:
       1. No remaining references to the old Account → Server configuration path
       2. No references to the intermediate wrong path Account → Model Manager
       3. Catches both arrow variants (→ and ->) in error messages and docs */

    const repoRoot = path.resolve(__dirname, '../../../');
    const dirsToScan = [
      path.join(repoRoot, 'server', 'src'),
      path.join(repoRoot, 'src'),
      path.join(repoRoot, 'docs', 'wiki'),  // Only current wiki, not archive or design docs
      path.join(repoRoot, 'INSTALL.md'),
      path.join(repoRoot, 'server', '.env.example'),
      path.join(repoRoot, 'CLAUDE.md'),
    ];

    // Patterns to search for (both variants for robustness)
    const stalePatterns = [
      'Account → Server configuration',  // Unicode arrow
      'Account -> Server configuration',  // ASCII arrow
      'Account → Model Manager → Gemini', // Intermediate wrong path
      'Account -> Model Manager -> Gemini', // ASCII variant of intermediate
    ];

    const dirsToExclude = ['node_modules', 'dist', '.git', 'build', 'coverage', 'archive', 'plans', 'specs', 'features'];

    const failingFiles: string[] = [];
    const scannedFiles = new Set<string>();

    function walkDir(dir: string) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          // Skip excluded dirs
          if (dirsToExclude.includes(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (
            entry.isFile() &&
            (/\.(ts|tsx|md|mjs|env\.example)$/.test(entry.name) ||
              entry.name === 'INSTALL.md' ||
              entry.name === 'CLAUDE.md')
          ) {
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              scannedFiles.add(fullPath);

              for (const pattern of stalePatterns) {
                if (content.includes(pattern) && !fullPath.includes('gemini-api-key-path.guard.test.ts')) {
                  const lineNum = content.substring(0, content.indexOf(pattern)).split('\n').length;
                  failingFiles.push(`${pattern} at ${fullPath}:${lineNum}`);
                }
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Skip unreadable dirs
      }
    }

    // Scan the main directories
    for (const dirOrFile of dirsToScan) {
      if (fs.existsSync(dirOrFile)) {
        if (fs.statSync(dirOrFile).isDirectory()) {
          walkDir(dirOrFile);
        } else {
          try {
            const content = fs.readFileSync(dirOrFile, 'utf-8');
            scannedFiles.add(dirOrFile);
            for (const pattern of stalePatterns) {
              if (content.includes(pattern)) {
                const lineNum = content.substring(0, content.indexOf(pattern)).split('\n').length;
                failingFiles.push(`${pattern} at ${dirOrFile}:${lineNum}`);
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    // Also verify that the correct path appears in at least one error message
    try {
      const analyzerIndex = fs.readFileSync(
        path.resolve(__dirname, './index.ts'),
        'utf-8'
      );
      if (!analyzerIndex.includes('Admin → Model Manager → Gemini API key')) {
        failingFiles.push(
          'Missing correct path: "Admin → Model Manager → Gemini API key" not found in analyzer/index.ts'
        );
      }
    } catch {
      // File might not exist, that's ok
    }

    const errorMsg =
      failingFiles.length > 0
        ? `Found stale Gemini API key paths:\n${failingFiles.join('\n')}`
        : '';

    expect(failingFiles, errorMsg).toHaveLength(0);
  });
});
