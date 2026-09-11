import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Gemini API key path guard', () => {
  it('ensures no code contains the old "Account → Server configuration" path for Gemini API key', () => {
    /* The Gemini API key location moved from Account → Server configuration
       to Admin → Model Manager (2026-07-15). This guard catches any remaining
       references to the old path in error messages or documentation. */
    const filesToCheck = [
      './index.ts',
      './voice-style.ts',
    ];

    const oldPath = 'Account → Server configuration';
    const failingFiles: string[] = [];

    for (const filePath of filesToCheck) {
      const fullPath = path.resolve(__dirname, filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes(oldPath)) {
        failingFiles.push(filePath);
      }
    }

    if (failingFiles.length > 0) {
      throw new Error(
        `Found old Gemini API key path in: ${failingFiles.join(', ')}. ` +
          `Update to "Admin → Model Manager → Gemini API key".`
      );
    }

    expect(failingFiles).toHaveLength(0);
  });
});
