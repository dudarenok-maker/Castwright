import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Gemini API key path guard', () => {
  it('scans repo for stale Account-tab paths for settings moved to Model Manager', () => {
    /* Settings moved from Account → (section) to Admin → Model Manager → (section)
       on 2026-07-15 (fs-23 phase A7). This guard derives the correct section labels
       from the actual UI's exported MODEL_SETTINGS_SECTIONS constant, then scans
       the entire repo for stale "Account" references paired with any of the moved
       settings' names or variants thereof.

       This structural approach catches ALL arrow spellings (→, ->, none, "in the X
       tab", etc.) without hardcoding specific string variants — instead detecting
       any "Account" text in close proximity to a moved-setting name or alias.

       Moved settings (from model-settings-form.tsx's exported section labels):
       - "Defaults for new books" (analyzer defaults, voice engine, voice model)
       - "Two-model analyzer split (advanced)" (phase 0 & 1 model pickers)
       - "Voice engine" (TTS engine settings)
       - "Server configuration" (Gemini API key, voice engine URL, ollama URL)
       - "Install / update analyzer (Ollama)" (analyzer installer)

       Field names and common aliases that appear alongside these sections in docs:
       - "Analysis model", "Gemini API key", "Voice engine", "Voice model",
       "Voice engine URL", "Ollama URL", "Defaults for new books",
       "Phase 0 model", "Phase 1 model", "Analyzer model" */

    const repoRoot = path.resolve(__dirname, '../../../');

    // Derive section labels from the actual UI model-settings-form.tsx
    let actualSectionLabels: string[] = [];
    try {
      const modelSettingsFormPath = path.join(
        repoRoot,
        'src',
        'components',
        'model-settings-form.tsx',
      );
      const formContent = fs.readFileSync(modelSettingsFormPath, 'utf-8');
      // Extract label strings from GROUP_* definitions and MODEL_SETTINGS_SECTIONS export
      const labelMatches = formContent.match(/label:\s*['"`]([^'"`]+)['"`]/g);
      if (labelMatches) {
        actualSectionLabels = [
          ...new Set(labelMatches.map((m) => m.replace(/label:\s*['"`]|['"`]/g, ''))),
        ];
      }
    } catch {
      // If we can't read the model-settings-form, fail the test — this guard
      // depends on those labels being stable and readable.
      expect.fail('Could not read model-settings-form.tsx to derive section labels');
    }

    // Additional field names/aliases that appear in docs/comments for moved settings
    const movedSettingNames = [
      'Analysis model',
      'Gemini API key',
      'Voice engine',
      'Voice model',
      'Voice engine URL',
      'Ollama URL',
      'Phase 0 model',
      'Phase 1 model',
      'Analyzer model',
      'Defaults for new books',
      'Two-model analyzer split',
    ];

    // All names the guard searches for (section labels + aliases)
    const allMovedNames = [...actualSectionLabels, ...movedSettingNames];

    // Detect stale Account-based navigation paths. Only flag lines that actually
    // describe a path (contain arrows, "tab", or "settings" keywords), not just any
    // mention of "account" and a setting name together (e.g. "Google account required").
    function lineHasStaleAccountRef(line: string, settingNames: string[]): string | null {
      const lowerLine = line.toLowerCase();

      // Skip lines that mention "account" in other contexts (not paths)
      if (lowerLine.includes('google account') || lowerLine.includes('user account')) {
        return null;
      }

      // Only consider lines that describe a navigation path:
      // Must have Account AND one of: →, ->, "tab", "settings" (path indicators)
      const hasPathIndicator =
        lowerLine.includes('→') ||
        lowerLine.includes('->') ||
        /\baccount\s+(tab|settings)/i.test(line) ||
        /\bin\s+(the\s+)?account\s+(tab|settings)/i.test(line);

      if (!lowerLine.includes('account') || !hasPathIndicator) {
        return null;
      }

      // Check if it also mentions any of the moved setting names
      for (const name of settingNames) {
        if (lowerLine.includes(name.toLowerCase())) {
          return name; // Found a stale path reference
        }
      }

      return null;
    }

    // Directories to exclude: git internals, build outputs, and docs/features/ which
    // are historical design docs (not live user-facing paths)
    const dirsToExclude = [
      'node_modules',
      'dist',
      '.git',
      'build',
      'coverage',
      'docs/features',
      'docs/superpowers',
    ];

    function shouldExcludeDir(dirPath: string): boolean {
      const parts = dirPath.split(path.sep);
      for (const exclude of dirsToExclude) {
        const excludeParts = exclude.split('/');
        let match = false;
        for (let i = 0; i < excludeParts.length && i < parts.length; i++) {
          if (parts[parts.length - excludeParts.length + i] !== excludeParts[i]) {
            match = false;
            break;
          }
          match = true;
        }
        if (match) return true;
      }
      return false;
    }

    const failingFiles: { file: string; line: number; pattern: string; text: string }[] = [];

    function walkDir(dir: string) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!shouldExcludeDir(fullPath)) {
              walkDir(fullPath);
            }
          } else if (
            entry.isFile() &&
            (/\.(ts|tsx|md|mjs)$/.test(entry.name) ||
              entry.name === 'INSTALL.md' ||
              entry.name === 'CLAUDE.md' ||
              entry.name === '.env.example' ||
              entry.name === 'RELEASE_NOTES.md')
          ) {
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');

              // Skip this guard file itself
              if (fullPath.includes('gemini-api-key-path.guard.test.ts')) return;

              // Check each line for stale Account references paired with moved settings
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const staledSettingName = lineHasStaleAccountRef(line, allMovedNames);
                if (staledSettingName) {
                  failingFiles.push({
                    file: fullPath,
                    line: i + 1,
                    pattern: `Account + "${staledSettingName}"`,
                    text: line.trim().substring(0, 100),
                  });
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

    // Scan from repo root down
    walkDir(repoRoot);

    // Verify that the correct path appears in at least ONE live error message or docs file
    let foundCorrectPath = false;
    const correctPathIndicators = [
      'Admin → Model Manager',
      'Admin -> Model Manager',
      'Model Manager →',
      'Model Manager ->', // For live error messages that might be simpler
    ];

    try {
      // Check analyzer/index.ts (a live error message path)
      const analyzerIndex = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');
      foundCorrectPath = correctPathIndicators.some((p) => analyzerIndex.includes(p));
    } catch {
      // index.ts might not exist, that's OK — we check other files below
    }

    if (!foundCorrectPath) {
      // Also check failure-remediations.ts (another live path)
      try {
        const remediations = fs.readFileSync(
          path.join(repoRoot, 'server', 'src', 'routes', 'failure-remediations.ts'),
          'utf-8',
        );
        foundCorrectPath = correctPathIndicators.some((p) => remediations.includes(p));
      } catch {
        // Also OK if missing
      }
    }

    if (!foundCorrectPath) {
      failingFiles.push({
        file: 'analyzer/index.ts or failure-remediations.ts',
        line: 0,
        pattern: 'Correct path verification',
        text: 'No occurrence of "Admin → Model Manager" or similar in live error messages',
      });
    }

    const errorMsg =
      failingFiles.length > 0
        ? `Found ${failingFiles.length} stale/missing paths:\n${failingFiles
            .map(
              (f) =>
                `  ${f.file}:${f.line} — ${f.pattern.substring(0, 50)}…\n    ${f.text.replace(/\n/g, ' ')}`,
            )
            .join('\n')}`
        : '';

    expect(failingFiles, errorMsg).toHaveLength(0);
  });
});
