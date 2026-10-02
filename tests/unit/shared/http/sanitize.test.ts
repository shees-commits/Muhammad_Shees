import { describe, expect, it } from 'vitest';
import { isStrictJson } from '../../../../src/shared/http/contentType.js';
import { sanitizeText } from '../../../../src/shared/http/sanitize.js';

describe('sanitizeText', () => {
  it('removes script tags together with their content', () => {
    expect(sanitizeText('Hello <script>alert(1)</script>world')).toBe('Hello world');
  });

  it('removes every HTML tag but keeps text', () => {
    expect(sanitizeText('<b>bold</b> <img src=x onerror=alert(1)>text')).toBe('bold text');
  });

  it('strips control characters but keeps newlines and tabs', () => {
    expect(sanitizeText('a\u0000b\u0007c\nd\te\u007f')).toBe('abc\nd\te');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeText('   question?  ')).toBe('question?');
  });

  it('returns an empty string for markup-only input', () => {
    expect(sanitizeText('<script>x</script>')).toBe('');
  });
});

describe('isStrictJson', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON', true],
    ['text/plain', false],
    ['application/json; charset=latin1', false],
    ['application/json-patch+json', false],
    ['application/x-www-form-urlencoded', false],
    ['multipart/form-data; boundary=x', false],
  ])('%s → %s', (contentType, expected) => {
    expect(isStrictJson(contentType)).toBe(expected);
  });
});
