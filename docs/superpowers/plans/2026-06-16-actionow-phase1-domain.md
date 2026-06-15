# Actionow Phase 1 — Domain Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Follow superpowers:test-driven-development for every task.

**Goal:** Implement the pure, no-IO domain core — shared contract types, the µcredit money model, the `io_schema`→zod input validator, the pricing engine (all 5 methods) + ordered modifier stack, and the job state machine — every piece unit-tested.

**Architecture:** Everything lives in `packages/contracts` (types + zod, the leaf) and `packages/domain` (pure functions, imports only `contracts`). No DB, no network, no NestJS — the `eslint-plugin-boundaries` config enforces this. The IO wrappers (atomic `hold`/`settle` SQL, idempotency, repositories) are NOT here; they come in Phase 3 and will _call_ these pure functions.

**Tech Stack:** TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 3, Vitest. Pricing math is **integer `bigint` µcredits** (1 credit = 1_000_000 µcredits) — no floats anywhere on the money path (design review #6).

**Source spec:** `docs/superpowers/specs/2026-06-16-actionow-backend-scaffold-design.md` — §4.5 (io_schema), §5 (job state machine), §6/§9 (pricing, modifier stack, methods). Behavior is governed by the spec; this plan sequences it.

---

## Money model (read before any pricing task)

- Unit of account: **µcredit** (micro-credit). `1 credit = 1_000_000n µcredits`. Type alias `MicroCredits = bigint`.
- **All pricebook numeric values (`rate`, `table` entries, `amount`, `flat` markups/modifiers) are integer µcredits** expressed as JS `number` (they fit in `Number.MAX_SAFE_INTEGER`); the admin/import layer (later phase) converts human "credits" → µcredits. Counts/multipliers (`input_tokens`, `duration_seconds`, image count, `characters`) are integer `number`.
- All arithmetic is done in `bigint`. Convert inputs with `BigInt(x)` at the boundary; never use `+`/`*` on floats for money.
- Percentages (`percent_off`, `percent_add`, markup `percent`) are **whole percent** integers (e.g. `20` = 20%). Percent math uses round-half-up: `(base * BigInt(100 ± pct) + 50n) / 100n`. Provide a shared `applyPercent` helper so rounding is identical everywhere.

---

## Conventions for every task

- Work from repo root `/Users/alienworm/actionow-core` on branch `feat/phase-1-domain`. Commit per task (Conventional Commits, **lowercase subject** — the commit-msg hook enforces `subject-case`). Do not push.
- TDD: write the failing test, run it red, implement minimally, run it green, commit.
- Run a package's tests with `pnpm --filter @actionow/<pkg> test`. Lint with `pnpm exec eslint <path>`. Strict ESLint is on (no `any`, explicit module-boundary return types, `consistent-type-imports`). Each new package source dir must be covered by its tsconfig `include` for the ESLint project service.
- `contracts` currently has only a placeholder `src/index.ts`. `domain` likewise. Both have `vitest` + `zod` already; add no new deps unless a task says so.

---

## Task 1: Shared contract types + zod (`@actionow/contracts`)

**Files:**

- Create: `packages/contracts/src/io-schema.ts`, `pricing.ts`, `modifier.ts`, `job.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: Write failing test** `packages/contracts/test/schemas.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { ioSchemaSchema } from '../src/io-schema.js';
import { pricebookEntrySchema } from '../src/pricing.js';
import { modifierSchema } from '../src/modifier.js';
import { JOB_STATUSES, jobStatusSchema } from '../src/job.js';

describe('io-schema', () => {
  it('accepts a valid io_schema', () => {
    const parsed = ioSchemaSchema.parse({
      inputs: [{ key: 'prompt', type: 'string', required: true, maxLength: 100 }],
      outputs: [{ key: 'video_url', type: 'string', render: 'video' }],
    });
    expect(parsed.inputs[0]?.key).toBe('prompt');
  });
  it('rejects an unknown field type', () => {
    expect(() =>
      ioSchemaSchema.parse({ inputs: [{ key: 'x', type: 'blob' }], outputs: [] }),
    ).toThrow();
  });
});

describe('pricing', () => {
  it('accepts a unit (post) pricebook entry', () => {
    const e = pricebookEntrySchema.parse({
      resourceId: 'model:openai/gpt',
      resourceVersion: 1,
      version: 7,
      method: 'unit',
      timing: 'post',
      spec: {
        method: 'unit',
        dimensions: { input_tokens: { rate: 150 }, output_tokens: { rate: 600 } },
      },
    });
    expect(e.method).toBe('unit');
  });
  it('accepts a matrix (pre) entry with multiplier', () => {
    const e = pricebookEntrySchema.parse({
      resourceId: 'model:kling/v2',
      resourceVersion: 1,
      version: 1,
      method: 'matrix',
      timing: 'pre',
      spec: {
        method: 'matrix',
        key: ['resolution'],
        table: { '720p': 1200000, '1080p': 2500000 },
        multiplier: 'duration_seconds',
      },
    });
    expect(e.spec.method).toBe('matrix');
  });
  it('rejects a method/spec mismatch', () => {
    expect(() =>
      pricebookEntrySchema.parse({
        resourceId: 'r',
        resourceVersion: 1,
        version: 1,
        method: 'fixed',
        timing: 'pre',
        spec: { method: 'unit', dimensions: {} },
      }),
    ).toThrow();
  });
});

describe('modifier + job', () => {
  it('accepts a percent_off modifier', () => {
    const m = modifierSchema.parse({
      id: 'volume',
      scope: 'tenant:acme',
      op: 'percent_off',
      value: 10,
      stackable: true,
      priority: 1,
      version: 1,
    });
    expect(m.op).toBe('percent_off');
  });
  it('exposes the 5 job statuses', () => {
    expect(JOB_STATUSES).toEqual(['queued', 'running', 'succeeded', 'failed', 'canceled']);
    expect(jobStatusSchema.parse('running')).toBe('running');
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @actionow/contracts test` → FAIL (modules missing).

- [ ] **Step 3: Implement `io-schema.ts`**

```ts
import { z } from 'zod';

export const IO_TYPES = ['string', 'number', 'boolean', 'enum', 'file', 'file_list'] as const;
export type IoType = (typeof IO_TYPES)[number];

export const ioFieldSchema = z.object({
  key: z.string().min(1),
  type: z.enum(IO_TYPES),
  label: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  maxLength: z.number().int().positive().optional(),
  widget: z.string().optional(),
  render: z.string().optional(),
});
export type IoField = z.infer<typeof ioFieldSchema>;

export const ioSchemaSchema = z.object({
  inputs: z.array(ioFieldSchema),
  outputs: z.array(ioFieldSchema),
});
export type IoSchema = z.infer<typeof ioSchemaSchema>;
```

- [ ] **Step 4: Implement `pricing.ts`** (discriminated union on `method`; cross-check method===spec.method via `superRefine`)

```ts
import { z } from 'zod';

export const PRICE_METHODS = ['unit', 'matrix', 'fixed', 'formula', 'passthrough'] as const;
export type PriceMethod = (typeof PRICE_METHODS)[number];
export const PRICE_TIMINGS = ['pre', 'post'] as const;
export type PriceTiming = (typeof PRICE_TIMINGS)[number];

export const markupSchema = z.object({
  type: z.enum(['percent', 'flat']),
  value: z.number().int(),
});
export type Markup = z.infer<typeof markupSchema>;

export const unitSpecSchema = z.object({
  method: z.literal('unit'),
  dimensions: z.record(z.string(), z.object({ rate: z.number().int().nonnegative() })),
});
export const matrixSpecSchema = z.object({
  method: z.literal('matrix'),
  key: z.array(z.string()).min(1),
  table: z.record(z.string(), z.number().int().nonnegative()),
  multiplier: z.string().optional(),
  perItem: z.string().optional(),
});
export const fixedSpecSchema = z.object({
  method: z.literal('fixed'),
  amount: z.number().int().nonnegative(),
});
export const formulaSpecSchema = z.object({
  method: z.literal('formula'),
  expr: z.string().min(1),
});
export const passthroughSpecSchema = z.object({
  method: z.literal('passthrough'),
  markup: markupSchema.optional(),
});

export const priceSpecSchema = z.discriminatedUnion('method', [
  unitSpecSchema,
  matrixSpecSchema,
  fixedSpecSchema,
  formulaSpecSchema,
  passthroughSpecSchema,
]);
export type PriceSpec = z.infer<typeof priceSpecSchema>;

export const pricebookEntrySchema = z
  .object({
    resourceId: z.string(),
    resourceVersion: z.number().int(),
    version: z.number().int(),
    method: z.enum(PRICE_METHODS),
    timing: z.enum(PRICE_TIMINGS),
    spec: priceSpecSchema,
    markup: markupSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.method !== e.spec.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'method must equal spec.method',
        path: ['spec', 'method'],
      });
    }
  });
export type PricebookEntry = z.infer<typeof pricebookEntrySchema>;
```

- [ ] **Step 5: Implement `modifier.ts`**

```ts
import { z } from 'zod';

export const MODIFIER_OPS = ['override_rate', 'percent_off', 'flat_off', 'percent_add'] as const;
export type ModifierOp = (typeof MODIFIER_OPS)[number];

export const modifierSchema = z.object({
  id: z.string(),
  scope: z.string(),
  whenExpr: z.string().optional(),
  op: z.enum(MODIFIER_OPS),
  value: z.number().int().optional(),
  stackable: z.boolean(),
  priority: z.number().int(),
  version: z.number().int(),
});
export type Modifier = z.infer<typeof modifierSchema>;
```

- [ ] **Step 6: Implement `job.ts`**

```ts
import { z } from 'zod';

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusSchema = z.enum(JOB_STATUSES);

export const JOB_EVENTS = ['start', 'succeed', 'fail', 'cancel'] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];
```

- [ ] **Step 7: Replace `index.ts` barrel**

```ts
export * from './io-schema.js';
export * from './pricing.js';
export * from './modifier.js';
export * from './job.js';
```

- [ ] **Step 8: Run green** — `pnpm --filter @actionow/contracts test` → PASS. Then `pnpm --filter @actionow/contracts typecheck` and `pnpm exec eslint packages/contracts` → clean. (Ensure `packages/contracts/tsconfig.json` includes `test`; mirror the db package's tsconfig include if needed so ESLint's project service covers tests.)

- [ ] **Step 9: Commit** — `git commit -am "feat(contracts): add io-schema, pricing, modifier, job types + zod"`

---

## Task 2: µcredit money model + domain errors (`@actionow/domain`)

**Files:**

- Create: `packages/domain/src/credits.ts`, `packages/domain/src/errors.ts`
- Test: `packages/domain/test/credits.test.ts`

- [ ] **Step 1: Failing test** `packages/domain/test/credits.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { applyPercent, creditsToMicro, MICRO_PER_CREDIT, microToDisplay } from '../src/credits.js';

describe('credits', () => {
  it('MICRO_PER_CREDIT is 1e6', () => {
    expect(MICRO_PER_CREDIT).toBe(1_000_000n);
  });
  it('creditsToMicro converts a decimal credit value exactly', () => {
    expect(creditsToMicro(12.5)).toBe(12_500_000n);
    expect(creditsToMicro(0.00015)).toBe(150n);
  });
  it('microToDisplay formats µcredits as a credit string', () => {
    expect(microToDisplay(12_500_000n)).toBe('12.5');
    expect(microToDisplay(150n)).toBe('0.00015');
  });
  it('applyPercent rounds half up', () => {
    // 10% off 1000005 => 1000005 * 90 / 100 = 900004.5 -> 900005
    expect(applyPercent(1_000_005n, -10)).toBe(900_005n);
    // 20% add on 10 => 10 * 120 / 100 = 12
    expect(applyPercent(10n, 20)).toBe(12n);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @actionow/domain test` → FAIL.

- [ ] **Step 3: Implement `credits.ts`**

```ts
export const MICRO_PER_CREDIT = 1_000_000n;
export type MicroCredits = bigint;

/** Convert a human credit amount to integer µcredits (admin/import boundary only). */
export function creditsToMicro(credits: number): MicroCredits {
  return BigInt(Math.round(credits * 1_000_000));
}

/** Format µcredits as a trimmed decimal credit string for display. */
export function microToDisplay(micro: MicroCredits): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO_PER_CREDIT;
  const frac = abs % MICRO_PER_CREDIT;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  const body = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

/** Apply a whole-percent delta (e.g. -10 = 10% off, +20 = 20% add) with round-half-up. */
export function applyPercent(base: MicroCredits, percentDelta: number): MicroCredits {
  const factor = BigInt(100 + percentDelta);
  return (base * factor + 50n) / 100n;
}
```

- [ ] **Step 4: Run green** — test PASS.

- [ ] **Step 5: Implement `errors.ts`** (typed domain errors carrying a stable `code` → mapped to §4.7 by the api layer later)

```ts
export type DomainErrorCode =
  | 'invalid_input'
  | 'invalid_pricing'
  | 'price_key_not_found'
  | 'invalid_transition';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
```

- [ ] **Step 6: Replace `domain/src/index.ts` barrel**

```ts
export * from './credits.js';
export * from './errors.js';
```

- [ ] **Step 7: typecheck + eslint** `packages/domain` → clean. (Add `test` to domain tsconfig include like contracts.)

- [ ] **Step 8: Commit** — `git commit -am "feat(domain): add µcredit money model + typed domain errors"`

---

## Task 3: `io_schema` → zod input validator (`@actionow/domain`)

**Files:**

- Create: `packages/domain/src/io-schema/compile.ts`, `packages/domain/src/io-schema/index.ts`
- Test: `packages/domain/test/io-schema.test.ts`

**Interface:** `validateInputs(schema: IoSchema, inputs: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: DomainError }`. Maps each `IoField` to a zod schema (string→`z.string()` (+`max(maxLength)`), number→`z.number()`, boolean→`z.boolean()`, enum→`z.enum(options)`, file→`z.string()` (a ref/url placeholder), file_list→`z.array(z.string())`); applies `required`/`default`; rejects unknown keys.

- [ ] **Step 1: Failing test** `packages/domain/test/io-schema.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { IoSchema } from '@actionow/contracts';

import { validateInputs } from '../src/io-schema/index.js';

const schema: IoSchema = {
  inputs: [
    { key: 'prompt', type: 'string', required: true, maxLength: 5 },
    { key: 'tone', type: 'enum', options: ['a', 'b'], default: 'a' },
    { key: 'count', type: 'number', required: false },
  ],
  outputs: [],
};

describe('validateInputs', () => {
  it('accepts valid inputs and fills defaults', () => {
    const r = validateInputs(schema, { prompt: 'hi' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ prompt: 'hi', tone: 'a' });
  });
  it('rejects missing required field', () => {
    const r = validateInputs(schema, { tone: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
  it('rejects maxLength violation', () => {
    expect(validateInputs(schema, { prompt: 'toolong' }).ok).toBe(false);
  });
  it('rejects value not in enum', () => {
    expect(validateInputs(schema, { prompt: 'hi', tone: 'z' }).ok).toBe(false);
  });
  it('rejects unknown keys', () => {
    expect(validateInputs(schema, { prompt: 'hi', extra: 1 }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement `compile.ts`** — `compileInputs(schema: IoSchema): z.ZodType` building a `z.object({...}).strict()` from the input fields (apply `.optional()`/`.default()`; `maxLength` → `.max()`; enum → `z.enum`). Handle `enum` with empty/undefined `options` by treating it as `z.never()` (invalid schema) — but prefer to guard: if an enum field has no options, that's an `invalid_input` config; in the compiler throw `DomainError('invalid_input', ...)`. Show the full implementation (no placeholders) handling each `IoType`, `required` (default true when omitted? — NO: in this system `required` defaults to **false** unless `required === true`), and `default`.

- [ ] **Step 4: Implement `index.ts`** — `validateInputs` wraps `compileInputs(...).safeParse(inputs)`, returning the discriminated result; on failure build `new DomainError('invalid_input', issues...)`.

- [ ] **Step 5: Run green.** All 5 tests pass.

- [ ] **Step 6: Add exhaustive cases** (TDD): boolean type, file/file_list types, multiple required violations, default not overriding provided value. Implement until green.

- [ ] **Step 7: Update `domain/src/index.ts`** to `export * from './io-schema/index.js';`. typecheck + eslint clean.

- [ ] **Step 8: Commit** — `git commit -am "feat(domain): compile io_schema to zod and validate inputs"`

---

## Task 4: Pricing engine — methods, quote, settle, markup (`@actionow/domain`)

**Files:**

- Create: `packages/domain/src/pricing/methods.ts`, `pricing/markup.ts`, `pricing/quote.ts`, `pricing/index.ts`
- Test: `packages/domain/test/pricing.test.ts`

**Interfaces (return `MicroCredits`):**

- `priceUnit(spec: UnitSpec, usage: Record<string, number>): MicroCredits` — Σ `BigInt(usage[dim] ?? 0) * BigInt(rate)`.
- `priceMatrix(spec: MatrixSpec, params: Record<string, unknown>): MicroCredits` — build the table key by joining `spec.key.map(k => String(params[k]))` with `'|'`; look up; missing → `DomainError('price_key_not_found')`; multiply by `BigInt(params[spec.multiplier] ?? 1)` and `BigInt(params[spec.perItem] ?? 1)` when present.
- `priceFixed(spec: FixedSpec): MicroCredits` — `BigInt(spec.amount)`.
- `priceFormula(spec, vars)` — **Phase-1 scope:** implement a restricted evaluator supporting only `+ - * ( )` and integer literals + named non-negative integer variables (no division, no floats, no JS `eval`). Tokenise → shunting-yard → evaluate in `bigint`. (This is the single non-trivial piece; full code in the task below.)
- `applyMarkup(base, markup?): MicroCredits` — `percent` → `applyPercent(base, markup.value)`; `flat` → `base + BigInt(markup.value)`; undefined → base.
- `quote(entry, params)` — dispatch by `entry.spec.method` for the **pre** path (fixed/matrix/formula), then `applyMarkup`. Throw `DomainError('invalid_pricing')` if called with a post-only method (unit/passthrough) — those need usage.
- `settle(entry, usage)` — for **post** path: `unit` → `priceUnit`; `passthrough` → caller passes the summed child cost as `usage.subtotal` (µcredits) and we `applyMarkup`. Then `applyMarkup` from `entry.markup`/`spec.markup`.

- [ ] **Step 1: Failing test** `packages/domain/test/pricing.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { PricebookEntry } from '@actionow/contracts';

import { priceFormula, quote, settle } from '../src/pricing/index.js';

const unitEntry: PricebookEntry = {
  resourceId: 'm',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: {
    method: 'unit',
    dimensions: { input_tokens: { rate: 150 }, output_tokens: { rate: 600 } },
  },
};
const matrixEntry: PricebookEntry = {
  resourceId: 'm',
  resourceVersion: 1,
  version: 1,
  method: 'matrix',
  timing: 'pre',
  spec: {
    method: 'matrix',
    key: ['resolution'],
    table: { '720p': 1_200_000, '1080p': 2_500_000 },
    multiplier: 'duration_seconds',
  },
};
const fixedEntry: PricebookEntry = {
  resourceId: 'cap',
  resourceVersion: 1,
  version: 1,
  method: 'fixed',
  timing: 'pre',
  spec: { method: 'fixed', amount: 10_000_000 },
};
const passEntry: PricebookEntry = {
  resourceId: 'cap',
  resourceVersion: 1,
  version: 1,
  method: 'passthrough',
  timing: 'post',
  spec: { method: 'passthrough', markup: { type: 'percent', value: 20 } },
};

describe('pricing', () => {
  it('unit settles by usage', () => {
    expect(settle(unitEntry, { input_tokens: 1000, output_tokens: 500 })).toBe(150_000n + 300_000n);
  });
  it('matrix quotes table * multiplier', () => {
    expect(quote(matrixEntry, { resolution: '1080p', duration_seconds: 5 })).toBe(12_500_000n);
  });
  it('matrix throws on missing key', () => {
    expect(() => quote(matrixEntry, { resolution: '4k', duration_seconds: 5 })).toThrow(
      /price_key_not_found/,
    );
  });
  it('fixed quotes its amount', () => {
    expect(quote(fixedEntry, {})).toBe(10_000_000n);
  });
  it('passthrough settles subtotal + markup', () => {
    expect(settle(passEntry, { subtotal: 1_000_000 })).toBe(1_200_000n);
  });
  it('formula evaluates restricted integer expr', () => {
    expect(
      priceFormula({ method: 'formula', expr: 'base + steps * 3' }, { base: 100, steps: 4 }),
    ).toBe(112n);
  });
  it('formula rejects division / eval injection', () => {
    expect(() => priceFormula({ method: 'formula', expr: 'base / 0' }, { base: 1 })).toThrow();
    expect(() => priceFormula({ method: 'formula', expr: 'process.exit(1)' }, {})).toThrow();
  });
});
```

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement `methods.ts`** including the restricted formula evaluator. Full implementation (no placeholders):

```ts
import type { FixedSpec, FormulaSpec, MatrixSpec, UnitSpec } from '@actionow/contracts';

import { DomainError } from '../errors.js';
import type { MicroCredits } from '../credits.js';

export function priceUnit(spec: UnitSpec, usage: Record<string, number>): MicroCredits {
  let total = 0n;
  for (const [dim, { rate }] of Object.entries(spec.dimensions)) {
    total += BigInt(usage[dim] ?? 0) * BigInt(rate);
  }
  return total;
}

export function priceMatrix(spec: MatrixSpec, params: Record<string, unknown>): MicroCredits {
  const key = spec.key.map((k) => String(params[k])).join('|');
  const cell = spec.table[key];
  if (cell === undefined) throw new DomainError('price_key_not_found', `no price for key "${key}"`);
  let result = BigInt(cell);
  if (spec.multiplier !== undefined) result *= BigInt(Number(params[spec.multiplier] ?? 1));
  if (spec.perItem !== undefined) result *= BigInt(Number(params[spec.perItem] ?? 1));
  return result;
}

export function priceFixed(spec: FixedSpec): MicroCredits {
  return BigInt(spec.amount);
}

// Restricted integer expression evaluator: + - * ( ) , integer literals, non-negative integer vars. No /, no floats, no eval.
export function priceFormula(spec: FormulaSpec, vars: Record<string, number>): MicroCredits {
  const tokens = spec.expr.match(/\d+|[A-Za-z_]\w*|[()+\-*]/g);
  if (!tokens || tokens.join('') !== spec.expr.replace(/\s+/g, '')) {
    throw new DomainError('invalid_pricing', `illegal formula: ${spec.expr}`);
  }
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2 };
  const output: bigint[] = [];
  const ops: string[] = [];
  const apply = (op: string): void => {
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined)
      throw new DomainError('invalid_pricing', 'malformed formula');
    output.push(op === '+' ? a + b : op === '-' ? a - b : a * b);
  };
  for (const t of tokens) {
    if (/^\d+$/.test(t)) output.push(BigInt(t));
    else if (/^[A-Za-z_]\w*$/.test(t)) {
      const v = vars[t];
      if (v === undefined || !Number.isInteger(v) || v < 0)
        throw new DomainError('invalid_pricing', `bad var ${t}`);
      output.push(BigInt(v));
    } else if (t === '(') ops.push(t);
    else if (t === ')') {
      while (ops.length > 0 && ops[ops.length - 1] !== '(') apply(ops.pop() as string);
      if (ops.pop() !== '(') throw new DomainError('invalid_pricing', 'unbalanced parens');
    } else {
      while (
        ops.length > 0 &&
        ops[ops.length - 1] !== '(' &&
        (prec[ops[ops.length - 1] as string] ?? 0) >= (prec[t] ?? 0)
      ) {
        apply(ops.pop() as string);
      }
      ops.push(t);
    }
  }
  while (ops.length > 0) {
    const op = ops.pop() as string;
    if (op === '(') throw new DomainError('invalid_pricing', 'unbalanced parens');
    apply(op);
  }
  const result = output.pop();
  if (result === undefined || output.length > 0)
    throw new DomainError('invalid_pricing', 'malformed formula');
  return result;
}
```

- [ ] **Step 4: Implement `markup.ts`**

```ts
import type { Markup } from '@actionow/contracts';

import { applyPercent, type MicroCredits } from '../credits.js';

export function applyMarkup(base: MicroCredits, markup: Markup | undefined): MicroCredits {
  if (markup === undefined) return base;
  return markup.type === 'percent' ? applyPercent(base, markup.value) : base + BigInt(markup.value);
}
```

- [ ] **Step 5: Implement `quote.ts`** (`quote` for pre, `settle` for post; both apply `entry.markup`). Full code:

```ts
import type { PassthroughSpec, PricebookEntry } from '@actionow/contracts';

import type { MicroCredits } from '../credits.js';
import { DomainError } from '../errors.js';
import { applyMarkup } from './markup.js';
import { priceFixed, priceFormula, priceMatrix, priceUnit } from './methods.js';

export function quote(entry: PricebookEntry, params: Record<string, unknown>): MicroCredits {
  const spec = entry.spec;
  let base: MicroCredits;
  switch (spec.method) {
    case 'fixed':
      base = priceFixed(spec);
      break;
    case 'matrix':
      base = priceMatrix(spec, params);
      break;
    case 'formula':
      base = priceFormula(spec, params as Record<string, number>);
      break;
    default:
      throw new DomainError('invalid_pricing', `quote() needs a pre method, got ${spec.method}`);
  }
  return applyMarkup(base, entry.markup);
}

export function settle(entry: PricebookEntry, usage: Record<string, number>): MicroCredits {
  const spec = entry.spec;
  let base: MicroCredits;
  if (spec.method === 'unit') {
    base = priceUnit(spec, usage);
  } else if (spec.method === 'passthrough') {
    const inner = applyMarkup(BigInt(usage.subtotal ?? 0), (spec as PassthroughSpec).markup);
    return applyMarkup(inner, entry.markup);
  } else {
    throw new DomainError('invalid_pricing', `settle() needs a post method, got ${spec.method}`);
  }
  return applyMarkup(base, entry.markup);
}
```

- [ ] **Step 6: Implement `pricing/index.ts`** barrel (`export * from './methods.js'; './markup.js'; './quote.js';`).

- [ ] **Step 7: Run green;** add exhaustive cases (perItem multiplier, parens in formula, negative-result guard, markup flat). Update `domain/src/index.ts` to export pricing. typecheck + eslint clean.

- [ ] **Step 8: Commit** — `git commit -am "feat(domain): pricing engine (unit/matrix/fixed/formula/passthrough) + markup"`

---

## Task 5: Ordered modifier stack (`@actionow/domain`)

**Files:**

- Create: `packages/domain/src/pricing/modifier-stack.ts`
- Test: `packages/domain/test/modifier-stack.test.ts`

**Interface:** `applyModifiers(base: MicroCredits, modifiers: Modifier[]): { final: MicroCredits; applied: { id: string; version: number; before: MicroCredits; after: MicroCredits }[] }`.
Order (§9.2 fixed): sort applicable modifiers by `priority` ascending (caller encodes the fixed order: tenant override=0, volume tier=1, promo/coupon=2, publisher markup=3). Within the **same priority**, default policy = **take the single most favorable to the buyer** (lowest resulting value) and skip the rest. Apply ops: `override_rate` → set to `value`; `percent_off` → `applyPercent(x, -value)`; `flat_off` → `max(0, x - value)`; `percent_add` → `applyPercent(x, +value)`. Final never below 0. Record each applied step for audit (review #7 — the caller persists `{id, version, value}`).

- [ ] **Step 1: Failing test** `packages/domain/test/modifier-stack.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { Modifier } from '@actionow/contracts';

import { applyModifiers } from '../src/pricing/modifier-stack.js';

const mk = (p: Partial<Modifier> & Pick<Modifier, 'id' | 'op' | 'priority'>): Modifier => ({
  scope: 'global',
  stackable: true,
  version: 1,
  value: 0,
  ...p,
});

describe('applyModifiers', () => {
  it('applies in priority order: volume then publisher markup', () => {
    const r = applyModifiers(1_000_000n, [
      mk({ id: 'pub', op: 'percent_add', value: 20, priority: 3 }),
      mk({ id: 'vol', op: 'percent_off', value: 10, priority: 1 }),
    ]);
    // 1_000_000 *0.9 = 900_000 ; *1.2 = 1_080_000
    expect(r.final).toBe(1_080_000n);
    expect(r.applied.map((a) => a.id)).toEqual(['vol', 'pub']);
  });
  it('override_rate replaces the base', () => {
    expect(
      applyModifiers(5_000_000n, [
        mk({ id: 'c', op: 'override_rate', value: 2_000_000, priority: 0 }),
      ]).final,
    ).toBe(2_000_000n);
  });
  it('same priority takes the most favorable to buyer', () => {
    const r = applyModifiers(1_000_000n, [
      mk({ id: 'p15', op: 'percent_off', value: 15, priority: 2 }),
      mk({ id: 'p10', op: 'percent_off', value: 10, priority: 2 }),
    ]);
    expect(r.final).toBe(850_000n);
    expect(r.applied.map((a) => a.id)).toEqual(['p15']);
  });
  it('flat_off never goes below zero', () => {
    expect(
      applyModifiers(100n, [mk({ id: 'f', op: 'flat_off', value: 999, priority: 2 })]).final,
    ).toBe(0n);
  });
});
```

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement `modifier-stack.ts`** — group by `priority`; for each group compute the candidate result of every modifier from the current running value, pick the min (most favorable), record it; carry forward. Show full code (no placeholders), `bigint` throughout, clamping at `0n`. Handle `value === undefined` as a config error (`DomainError('invalid_pricing')`).

- [ ] **Step 4: Run green;** add cases (override mid-stack, empty modifier list returns base, mixed ops across priorities). Update barrel + `domain/src/index.ts`.

- [ ] **Step 5: Commit** — `git commit -am "feat(domain): ordered modifier stack with audit trail"`

---

## Task 6: Job state machine (`@actionow/domain`)

**Files:**

- Create: `packages/domain/src/state-machine.ts`
- Test: `packages/domain/test/state-machine.test.ts`

**§5 transitions:** `queued --start--> running`; `queued|running --succeed--> succeeded`; `queued|running --fail--> failed`; `queued|running --cancel--> canceled`. Terminal: `succeeded|failed|canceled` (no transitions out). **Interface:** `transition(current: JobStatus, event: JobEvent): JobStatus` (throws `DomainError('invalid_transition')` on illegal); `isTerminal(status: JobStatus): boolean`.

- [ ] **Step 1: Failing test** `packages/domain/test/state-machine.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { isTerminal, transition } from '../src/state-machine.js';

describe('job state machine', () => {
  it('queued -> running on start', () => {
    expect(transition('queued', 'start')).toBe('running');
  });
  it('running -> succeeded on succeed', () => {
    expect(transition('running', 'succeed')).toBe('succeeded');
  });
  it('queued can fail or cancel directly', () => {
    expect(transition('queued', 'fail')).toBe('failed');
    expect(transition('queued', 'cancel')).toBe('canceled');
  });
  it('rejects illegal transition from terminal', () => {
    expect(() => transition('succeeded', 'start')).toThrow(/invalid_transition/);
  });
  it('isTerminal identifies terminal states', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });
});
```

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement `state-machine.ts`** — a `Record<JobStatus, Partial<Record<JobEvent, JobStatus>>>` table; `transition` looks up, throws `DomainError('invalid_transition', ...)` when absent; `isTerminal` = no outgoing events. Full code, no placeholders, typed with the contracts enums.

- [ ] **Step 4: Run green;** add cases (running->canceled, every illegal pair from a terminal). Update `domain/src/index.ts`.

- [ ] **Step 5: Commit** — `git commit -am "feat(domain): job state machine with guarded transitions"`

---

## Task 7: Verification gate

- [ ] **Step 1:** `pnpm --filter @actionow/contracts --filter @actionow/domain test` → all green; note the test count.
- [ ] **Step 2:** `pnpm typecheck` (whole repo) → green.
- [ ] **Step 3:** `pnpm lint` → 0 errors. (Confirm `domain` still imports only `@actionow/contracts` — boundaries stay green.)
- [ ] **Step 4:** `pnpm build` → green.
- [ ] **Step 5:** Boundaries spot-check — confirm no domain file imports db/infra/adapters; run `pnpm exec eslint packages/domain` clean.
- [ ] **Step 6:** Commit if any fixups — `git commit -am "chore: phase-1 domain verification gate green"`

---

## Phase 1 Definition of Done

- `@actionow/contracts` exports io_schema / pricing / modifier / job types + zod, validated by tests.
- `@actionow/domain` exports: µcredit helpers (`creditsToMicro`/`microToDisplay`/`applyPercent`), `validateInputs`, pricing (`quote`/`settle`/method fns/`applyMarkup`), `applyModifiers`, `transition`/`isTerminal` — all unit-tested, all pure.
- Money path is integer `bigint` µcredits end to end; no floats; percent rounding is round-half-up and centralized.
- `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all green; `domain` still imports only `contracts` (boundaries enforced).

> **Next plan:** Phase 2 — `ProviderAdapter` interface + the five adapters (openai/anthropic/gemini/async-media-mock/dify-byo), built against this domain core.
