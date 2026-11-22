import { describe, expect, it } from 'vitest';
import { decodeHeaderValue, encodeHeaderValue } from '../src/index.js';

// Cases from the spec's Value Encoding table (basic/transports/streamable-http).
describe('encodeHeaderValue', () => {
  it.each([
    ['us-west1', 'us-west1'],
    ['Hello, 世界', '=?base64?SGVsbG8sIOS4lueVjA==?='],
    [' padded ', '=?base64?IHBhZGRlZCA=?='],
    ['line1\nline2', '=?base64?bGluZTEKbGluZTI=?='],
    ['=?base64?literal?=', '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?='],
  ])('%j -> %j', (input, expected) => {
    expect(encodeHeaderValue(input)).toBe(expected);
    expect(decodeHeaderValue(expected)).toBe(input);
  });
});

describe('decodeHeaderValue', () => {
  it('passes plain values through', () =>
    expect(decodeHeaderValue('crm__read_customer')).toBe('crm__read_customer'));
  it('rejects invalid base64 inside a sentinel', () =>
    expect(decodeHeaderValue('=?base64?***?=')).toBeUndefined());
  it('rejects invalid UTF-8 inside a sentinel', () =>
    expect(decodeHeaderValue('=?base64?/w==?=')).toBeUndefined());
  it('treats the marker as case-sensitive', () =>
    expect(decodeHeaderValue('=?BASE64?eA==?=')).toBe('=?BASE64?eA==?='));
});
