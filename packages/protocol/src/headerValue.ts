/**
 * Header value encoding from MCP 2026-07-28 Streamable HTTP "Value Encoding".
 *
 * Values that are not plain visible ASCII (or have leading/trailing whitespace, or
 * already look like the sentinel) are sent as `=?base64?{base64(utf8)}?=`.
 *
 * The SDK applies this on the wire. The gateway keeps its own implementation so tests
 * can build hostile requests independently of the SDK, and so audit/policy code can
 * decode mirrored headers if it ever needs to read them.
 */

const PREFIX = '=?base64?';
const SUFFIX = '?=';
const PLAIN = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

export function isSentinel(value: string): boolean {
  return value.startsWith(PREFIX) && value.endsWith(SUFFIX) && value.length >= PREFIX.length + SUFFIX.length;
}

export function encodeHeaderValue(value: string): string {
  if (PLAIN.test(value) && !isSentinel(value)) return value;
  return `${PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${SUFFIX}`;
}

/** Returns the decoded value, or undefined if a sentinel carries invalid base64/UTF-8. */
export function decodeHeaderValue(value: string): string | undefined {
  if (!isSentinel(value)) return value;
  const b64 = value.slice(PREFIX.length, value.length - SUFFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(b64, 'base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
