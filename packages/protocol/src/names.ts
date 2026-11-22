/**
 * Namespaced tool names.
 *
 * The gateway exposes every upstream tool as `{slug}__{tool}`:
 *
 * - `slug` is assigned by an admin when the upstream is registered and matches
 *   `[a-z0-9]+(-[a-z0-9]+)*`. It can never contain `_`, so the first `__` in an exposed
 *   name always ends the slug, even if the upstream tool name itself contains `__`.
 * - The exposed name must stay within `[A-Za-z0-9_-]{1,64}`, the common denominator of
 *   LLM provider function-name rules, which is stricter than MCP's own SHOULD
 *   (`[A-Za-z0-9_.-]{1,128}`). Tools that cannot be exposed safely are rejected, never
 *   silently rewritten.
 *
 * Resolution is an exact, case-sensitive table lookup. Names are never parsed to decide
 * routing, which removes a whole class of namespace-confusion bypasses.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 24;
/** MCP 2026-07-28 server/tools "Tool Names" (SHOULD-level rules). */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
/** What the gateway is willing to expose to clients. */
export const EXPOSED_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SEPARATOR = '__';

export type NameResult = { ok: true; name: string } | { ok: false; reason: string };

export function isValidSlug(slug: string): boolean {
  return slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
}

export function exposeName(slug: string, upstreamToolName: string): NameResult {
  if (!isValidSlug(slug)) {
    return { ok: false, reason: `invalid upstream slug ${JSON.stringify(slug)}` };
  }
  if (!MCP_TOOL_NAME_PATTERN.test(upstreamToolName)) {
    return {
      ok: false,
      reason: `upstream tool name ${JSON.stringify(upstreamToolName)} violates MCP naming rules`,
    };
  }
  const name = `${slug}${SEPARATOR}${upstreamToolName}`;
  if (!EXPOSED_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: `exposed name ${JSON.stringify(name)} is not LLM-safe ([A-Za-z0-9_-]{1,64})`,
    };
  }
  return { ok: true, name };
}

export interface NameEntry<T> {
  exposedName: string;
  slug: string;
  upstreamToolName: string;
  value: T;
}

export interface Rejection {
  slug: string;
  upstreamToolName: string;
  reason: string;
}

/** Immutable-after-build lookup table from exposed name to upstream tool. */
export class ToolNameTable<T> {
  private readonly entries = new Map<string, NameEntry<T>>();
  private readonly rejected: Rejection[] = [];

  /** Returns the entry, or records a rejection and returns undefined. */
  add(slug: string, upstreamToolName: string, value: T): NameEntry<T> | undefined {
    const result = exposeName(slug, upstreamToolName);
    if (!result.ok) {
      this.rejected.push({ slug, upstreamToolName, reason: result.reason });
      return undefined;
    }
    if (this.entries.has(result.name)) {
      // Upstream returned a duplicate tool name; keep the first, refuse the rest.
      this.rejected.push({ slug, upstreamToolName, reason: `duplicate exposed name ${result.name}` });
      return undefined;
    }
    const entry: NameEntry<T> = { exposedName: result.name, slug, upstreamToolName, value };
    this.entries.set(result.name, entry);
    return entry;
  }

  /** Exact, case-sensitive lookup. No normalisation of any kind. */
  resolve(exposedName: string): NameEntry<T> | undefined {
    return this.entries.get(exposedName);
  }

  /** Entries in deterministic order (sorted by exposed name, code-unit order). */
  list(): NameEntry<T>[] {
    return [...this.entries.values()].sort((a, b) =>
      a.exposedName < b.exposedName ? -1 : a.exposedName > b.exposedName ? 1 : 0,
    );
  }

  rejections(): readonly Rejection[] {
    return this.rejected;
  }

  get size(): number {
    return this.entries.size;
  }
}
