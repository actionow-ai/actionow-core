// packages/spi/src/builtin.ts
//
// model-supply-greenfield 批次4 slice3 — the BUILTIN dialect assembly: one
// factory the API gateway module calls at boot to obtain a registry loaded
// with every in-repo dialect (批次2 wave2): the four code-aspect dialects
// (openai / anthropic / gemini / volc) plus the huimeng YAML pack (the DSL
// authoring track's production subject). Kept HERE (not in the api app) so
// the registry contents stay single-sourced next to the dialects themselves —
// a new in-repo dialect lands by editing THIS file only.
//
// §6 热更新一致性: the registry is addressed by exact `{ref, version}`;
// registering happens once per process at module wiring. Out-of-repo packs
// (operator-uploaded YAML) are a later batch's registry feed and layer on top
// via `registerPack`.
import { readFileSync } from 'node:fs';

import { anthropicDialect, geminiDialect, openaiDialect, volcDialect } from './dialects/index.js';
import { registerPack } from './dsl/engine.js';
import { DialectRegistry } from './registry.js';

/**
 * Read a builtin YAML pack shipped under `packages/spi/dialects/`. Resolved
 * relative to THIS module, so it works from both the source tree (`src/`, the
 * tsx runtime) and the compiled output (`dist/`) — both sit one level below
 * the package root.
 */
export function builtinDialectPackYaml(name: 'huimeng'): string {
  return readFileSync(new URL(`../dialects/${name}.dialect.yaml`, import.meta.url), 'utf8');
}

/**
 * Assemble a {@link DialectRegistry} pre-loaded with every builtin dialect:
 * the 批次2 code dialects + the huimeng DSL pack. Each call returns a FRESH
 * registry (registration is versioned and immutable, so callers wanting
 * isolation — tests, canaries — never share instances by accident).
 */
export function createBuiltinDialectRegistry(): DialectRegistry {
  const registry = new DialectRegistry();
  registry.register(openaiDialect);
  registry.register(anthropicDialect);
  registry.register(geminiDialect);
  registry.register(volcDialect);
  registerPack(registry, builtinDialectPackYaml('huimeng'));
  return registry;
}
