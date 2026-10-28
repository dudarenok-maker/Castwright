import { describe, it, expect } from 'vitest';
import { settingsIssueMessages } from './settings-issues';

describe('settingsIssueMessages', () => {
  it('extracts zod issue messages from a failed-save error', () => {
    const msg = 'User settings save failed (400): {"error":"Invalid user settings.","issues":[{"message":"A."},{"message":"B."}]}';
    expect(settingsIssueMessages(msg)).toEqual(['A.', 'B.']);
  });
  it('falls back to the body error, then the raw message', () => {
    expect(settingsIssueMessages('failed (400): {"error":"Invalid payload."}')).toEqual(['Invalid payload.']);
    expect(settingsIssueMessages('Network down')).toEqual(['Network down']);
    expect(settingsIssueMessages('')).toEqual([]);
  });
});
