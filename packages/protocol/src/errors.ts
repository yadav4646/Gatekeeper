/**
 * JSON-RPC error codes used by the gateway.
 *
 * MCP 2026-07-28 partitions the JSON-RPC server-error range: -32020..-32099 is reserved
 * for the specification, -32000..-32019 is implementation-defined. Gateway-specific
 * codes live in the implementation-defined range.
 */
export const ErrorCode = {
  // JSON-RPC 2.0
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  /** Also used by the spec for "Unknown tool" and "resource not found". */
  InvalidParams: -32602,
  InternalError: -32603,

  // MCP 2026-07-28 (basic/index#error-codes)
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,

  // Gateway-defined (implementation range)
  UpstreamUnavailable: -32010,
  UpstreamTimeout: -32011,
  RateLimited: -32012,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Message used for both unknown and policy-denied tools so the response is not an
 * oracle for which tools exist behind the gateway.
 */
export function unknownToolMessage(name: string): string {
  return `Unknown tool: ${name}`;
}
