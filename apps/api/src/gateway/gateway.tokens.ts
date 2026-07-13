/**
 * DI tokens local to the NEW gateway module (model-supply-greenfield 批次4
 * slice3). Kept out of `common/tokens.ts` deliberately: the old-world tokens
 * file is shared by the legacy execution path (双面并存 — the new world adds
 * files, it does not grow old ones).
 */

/** The versioned SPI {@link DialectRegistry} loaded with the builtin dialects (§6). */
export const GATEWAY_DIALECTS = Symbol('GATEWAY_DIALECTS');

/** The {@link HttpClient} the SPI pipeline transports over (§6-④). */
export const GATEWAY_HTTP = Symbol('GATEWAY_HTTP');

/**
 * The §7.5 artifact-persistence hook (engine `PersistHook`). OPTIONAL until
 * slice5 provides the real implementation: every terminal-settle seam (the
 * callback ingress included — 回调赢 settle 竞争时同样转存先于 succeeded)
 * already threads it, so wiring this provider is all slice5 needs to enforce
 * `require_persist` on EVERY path.
 */
export const GATEWAY_PERSIST = Symbol('GATEWAY_PERSIST');
