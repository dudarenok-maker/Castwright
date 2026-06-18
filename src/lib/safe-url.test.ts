import { describe, it, expect } from 'vitest';
import { safeImageSrc } from './safe-url';
describe('safeImageSrc', () => {
  it('passes http/https and same-origin relative paths', () => {
    expect(safeImageSrc('https://x/y.jpg')).toBe('https://x/y.jpg');
    expect(safeImageSrc('/api/books/abc/cover')).toBe('/api/books/abc/cover');
  });
  it('strips javascript:, data:, blob:', () => {
    expect(safeImageSrc('javascript:alert(1)')).toBe('');
    expect(safeImageSrc('data:image/svg+xml,<svg onload=alert(1)>')).toBe('');
    expect(safeImageSrc('blob:https://x/123')).toBe('');
    expect(safeImageSrc(null)).toBe('');
  });
});
