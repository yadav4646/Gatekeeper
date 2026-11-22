import type { AuthInfo } from '@modelcontextprotocol/server';
import type { CatalogEntry } from '../catalog.js';
import type { NameEntry } from '@gatekeeper/protocol';

/**
 * Extension points for the request pipeline. M1 ships placeholders; later milestones
 * replace them:
 *
 * - M2: `canSeeTool` / `canCallTool` become the role-based policy engine (default deny).
 * - M4: rate limiting and response caching wrap `canCallTool`/the upstream call.
 * - M6: `onCall` writes the audit log and OpenTelemetry spans.
 */

export interface CallerContext {
  /** Validated token info, once authentication exists (M2). */
  authInfo?: AuthInfo;
  /** The inbound HTTP request, for audit metadata. */
  request?: Request;
}

export type CallOutcome =
  'ok' | 'tool_error' | 'unknown_tool' | 'denied' | 'upstream_error' | 'protocol_error';

export interface CallEvent {
  at: string;
  /** The name the client asked for, exactly as received. */
  requestedName: string;
  upstream?: string;
  upstreamTool?: string;
  outcome: CallOutcome;
  latencyMs: number;
  errorCode?: number;
}

export interface GatewayHooks {
  canSeeTool(ctx: CallerContext, entry: NameEntry<CatalogEntry>): boolean | Promise<boolean>;
  canCallTool(
    ctx: CallerContext,
    entry: NameEntry<CatalogEntry>,
    args: Record<string, unknown> | undefined,
  ): boolean | Promise<boolean>;
  onCall(event: CallEvent): void;
}

/**
 * M1 ONLY: no authentication exists yet, so everything is visible and callable.
 * Replaced by the default-deny policy engine in M2. `main.ts` logs a warning when used.
 */
export const developmentAllowAllHooks: GatewayHooks = {
  canSeeTool: () => true,
  canCallTool: () => true,
  onCall: (event) => {
    // Arguments are deliberately not logged until redaction rules exist (M6).
    process.stdout.write(`${JSON.stringify({ msg: 'tool_call', ...event })}\n`);
  },
};
