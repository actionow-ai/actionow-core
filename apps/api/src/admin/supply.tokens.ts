/**
 * DI tokens local to the batch-5 offering lifecycle (golden probe + enable
 * gate). Kept out of `common/tokens.ts` (the old-world shared file — 双面并存:
 * the new world adds files) and separate from `gateway.tokens.ts` (the probe
 * surface is admin-scoped; providing the gateway tokens here would silently
 * couple the two modules' lifecycles).
 */

/** The versioned SPI DialectRegistry the golden probe resolves against (§6). */
export const PROBE_DIALECTS = Symbol('PROBE_DIALECTS');

/** The golden probe's OWN HttpClient — independent of request traffic (R5 deps). */
export const PROBE_HTTP = Symbol('PROBE_HTTP');

/**
 * DSL packs (`ReadonlyMap<string, DialectPack>` keyed `ref@version`) the
 * discovery feature reads `discovery` declarations from (§10 发现模型) — the
 * compiled Dialect drops them. Defaults to the builtin packs.
 */
export const DISCOVERY_PACKS = Symbol('DISCOVERY_PACKS');
