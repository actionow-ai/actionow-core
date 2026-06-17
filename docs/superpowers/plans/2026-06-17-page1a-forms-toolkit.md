# Page 1a — Forms Toolkit (structured inputs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Build the reusable structured-input toolkit so users never type raw JSON and every field can carry a description: `Tooltip` (+ `FormField.tooltip`), `KeyValueEditor`, `ChipsField`, `Drawer`, `lib/api/enums.ts`, and two domain editors `IoSchemaField` + `PricebookSpecForm`. These are consumed by Page 1b (Resources) and every later page.

**Architecture:** Pure shape-conversion helpers (rows⇄object, form⇄spec) are extracted and unit-tested; the components are thin wrappers composing existing primitives (`FormField`, `TextField`, `NumberField`, `SelectField`, `Toggle`, `Checkbox`). Backed by the real backend shapes (below).

**Tech Stack:** React 19, TS strict, react-i18next, Phosphor, GSAP, vitest + RTL/user-event.

Spec: `docs/superpowers/specs/2026-06-17-frontend-api-integration-design.md` §3–§4. Working dir `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`; tests `pnpm --filter @actionow/web exec vitest run`. Lowercase commits. Rules: no blue, no emoji (Phosphor), dark+light, button no-wrap, i18n both locales, tokens, a11y, reduced-motion. Read existing primitives first: `components/ui/{FormField,TextField,NumberField,SelectField,Toggle,Checkbox,Modal}.tsx`, `lib/useFocusTrap.ts`, `lib/motion/{gsap,tokens}`.

**Backend shapes (source of truth — already verified):**

- `IoField` (`packages/contracts/io-schema`): `{ key:string; type:'string'|'number'|'boolean'|'enum'|'file'|'file_list'; label?:string; required?:boolean; default?:unknown; options?:string[]; maxLength?:number }`. ioSchema = `{inputs:IoField[], outputs:IoField[]}`. enum requires non-empty `options`.
- Pricebook `spec` per method (units inside = **µcredits**, int≥0): `unit`=`{method:'unit',dimensions:{[d]:{rate:number}}}` · `matrix`=`{method:'matrix',key:string[],table:{[joinedKey]:number},multiplier?:string,perItem?:string}` · `fixed`=`{method:'fixed',amount:number}` (entered via `fixedCredits` human credits → backend builds amount) · `formula`=`{method:'formula',expr:string}` (only `+ - * ( )`, ints, var names) · `passthrough`=`{method:'passthrough',markup?:{type:'percent'|'flat',value:number}}`. Top-level `markup`=`{type:'percent'|'flat',value:number}`.
- channel `config` = arbitrary `Record<string, unknown>` (real examples all string values).
- `execModes` known values: `blocking` `stream` `async-poll` `async-callback`.

---

## File Structure

- `src/lib/api/enums.ts` (+ test) — option sets + `toOptions`.
- `src/components/ui/Tooltip.tsx` (+ test); `FormField.tsx` (modify: `tooltip?` prop).
- `src/components/ui/KeyValueEditor.tsx` (+ test); `src/components/ui/kvRows.ts` (pure helpers, tested).
- `src/components/ui/ChipsField.tsx` (+ test).
- `src/components/ui/Drawer.tsx` (+ test).
- `src/components/data/IoSchemaField.tsx` (+ test for build helpers in `ioSchemaShape.ts`).
- `src/components/data/PricebookSpecForm.tsx` (+ test for `pricebookSpec.ts` pure helpers).
- i18n `src/i18n/locales/{en,zh-CN}/console.json` — `enums.*`, `forms.*` (toolkit labels).

---

## Task 1: `enums.ts`

(Identical to the prior plan — option sets + `toOptions` + `COMMON_PROVIDERS`, plus add `EXEC_MODES = ['blocking','stream','async-poll','async-callback']`.)

- [ ] Test `enums.test.ts`: `MODALITIES.map(o=>o.value)` equals `['text','image','video','audio','composite']`; `toOptions(PRICEBOOK_METHODS, k=>'T:'+k)[0]` equals `{value:'unit',label:'T:enums.method.unit'}`.
- [ ] Implement `lib/api/enums.ts` exporting `EnumOption<V>`, `MODALITIES`, `RESOURCE_KINDS`, `PRICEBOOK_METHODS`, `PRICEBOOK_TIMINGS`, `CHANNEL_STATUSES`, `MARKUP_TYPES` (`[{value:'percent'},{value:'flat'}]`), `COMMON_PROVIDERS`, `EXEC_MODES`, and `toOptions(opts,t)` (maps `labelKey` via `t`). (Use `Modality`/`PricebookMethod`/`PricebookTiming`/`ChannelStatus` from `./types`.)
- [ ] Add `enums.*` i18n to BOTH locales (modality/kind/method/timing/channelStatus/markupType label maps — en + zh as in the prior plan; markupType: en `{percent:"Percent",flat:"Flat"}` zh `{percent:"百分比",flat:"定额"}`).
- [ ] Verify green. Commit `feat(web): enum option sets for selects`.

## Task 2: `Tooltip` + `FormField.tooltip`

**Files:** `components/ui/Tooltip.tsx` (+ test), `components/ui/FormField.tsx` (modify).

- [ ] **Test** `Tooltip.test.tsx`: renders a trigger (`aria-label` info), the content is in the DOM with `role="tooltip"` and linked via `aria-describedby`; hovering/focusing the trigger reveals it (assert it becomes visible / `data-open`). Keep it simple (CSS-driven visibility is fine; assert the tooltip text + aria wiring exist).
- [ ] **Implement** `Tooltip.tsx`: `Tooltip({ text, children? })` → a small Phosphor `InfoIcon` (or wraps `children`) button `aria-label={text}` with a `role="tooltip"` popover shown on hover/focus (CSS `:hover`/`:focus-visible` via a wrapper class, or a portal like Select). Warm `--overlay-bg` bubble, `--fs-caption`, `--dur-fast`; reduced-motion: no transition; no blue.
- [ ] **Modify `FormField`**: add optional `tooltip?: string`. When set, render the `Tooltip` next to the label text (inline-flex, gap). Keep `label/error/hint/required/id` behavior. (Read FormField first; preserve existing API.)
- [ ] Verify green. Commit `feat(web): tooltip + formfield tooltip slot`.

## Task 3: `KeyValueEditor` (+ pure helpers)

**Files:** `components/ui/kvRows.ts` (+ test), `components/ui/KeyValueEditor.tsx` (+ test).

- [ ] **Test** `kvRows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { objectFromRows, rowsFromObject } from './kvRows';
describe('kvRows', () => {
  it('rows→object drops blank keys, last-wins on dup', () => {
    expect(
      objectFromRows([
        { key: 'a', value: '1' },
        { key: '', value: 'x' },
        { key: 'a', value: '2' },
      ]),
    ).toEqual({ a: '2' });
  });
  it('object→rows is stable', () => {
    expect(rowsFromObject({ a: '1', b: '2' })).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });
  it('empty object → one blank row for editing', () => {
    expect(rowsFromObject({})).toEqual([{ key: '', value: '' }]);
  });
});
```

- [ ] Verify red. **Implement** `kvRows.ts`:

```ts
export interface KvRow {
  key: string;
  value: string;
}
export function rowsFromObject(obj: Record<string, unknown> | null | undefined): KvRow[] {
  const entries = Object.entries(obj ?? {});
  if (entries.length === 0) return [{ key: '', value: '' }];
  return entries.map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}
export function objectFromRows(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim() !== '') out[r.key.trim()] = r.value;
  return out;
}
```

- [ ] Verify green.
- [ ] **Implement** `KeyValueEditor.tsx`: `KeyValueEditor({ label?, tooltip?, value: Record<string,unknown>|undefined, onChange:(o:Record<string,string>)=>void, presets? })`. Holds `KvRow[]` state seeded by `rowsFromObject(value)`; each row = two `TextField`-style inputs (key/value) + a remove `IconButton` (Phosphor `XIcon`); an "add row" ghost `Button`; on any change calls `onChange(objectFromRows(rows))`. Optional `presets?: {label:string; value:Record<string,string>}[]` rendered as small ghost buttons that replace rows with `rowsFromObject(preset.value)`. Wrap in `FormField` (label/tooltip). a11y: each input labeled (`aria-label` key/value + index).
- [ ] **Test** `KeyValueEditor.test.tsx` (RTL): typing a key+value calls `onChange` with `{k:v}`; add/remove row works.
- [ ] Verify green. Commit `feat(web): keyvalueeditor for arbitrary record fields`.

## Task 4: `ChipsField`

**Files:** `components/ui/ChipsField.tsx` (+ test).

- [ ] **Test** `ChipsField.test.tsx` (RTL): renders existing chips; typing a value + Enter adds a chip and clears the input + calls `onChange([...,'new'])`; clicking a chip's remove calls `onChange` without it; a suggestion click adds it; duplicates are ignored.
- [ ] **Implement** `ChipsField({ label?, tooltip?, hint?, value: string[], onChange:(v:string[])=>void, suggestions?: string[], placeholder? })`: chips row (each = label + remove `XIcon` button), an input that adds on Enter/comma (trim, ignore empty/dup), optional suggestion chips below (those not already chosen) that add on click. Wrap in `FormField`. Tokens, no blue.
- [ ] Verify green. Commit `feat(web): chipsfield for string-list inputs`.

## Task 5: `Drawer`

**Files:** `components/ui/Drawer.tsx` (+ test). Model on `Modal.tsx` (deferred-unmount, `useFocusTrap(ref, open&&mounted)`, Escape, `--scrim` backdrop, `--overlay-bg` panel, GSAP slide from right `x:40→0`, reduced-motion instant). Props `{open,title,onClose,children,footer?,width?}`.

- [ ] **Test** `Drawer.test.tsx`: open → `role="dialog"` named by title + children present; Escape calls `onClose`.
- [ ] **Implement** per the prior plan's Drawer code (right-slide; full-height panel; `width='min(480px,96vw)'`).
- [ ] Verify green. Commit `feat(web): drawer side-panel`.

## Task 6: `IoSchemaField` (inputs/outputs builder)

**Files:** `components/data/ioSchemaShape.ts` (+ test), `components/data/IoSchemaField.tsx`.

- [ ] **Test** `ioSchemaShape.test.ts`: `emptyIoField()` → `{key:'',type:'string',required:false}`; `cleanField({key:' p ',type:'enum',options:['a'],required:true,maxLength:0})` trims key, keeps options, drops `maxLength:0`/empty; `cleanField` for non-enum drops `options`; a field with empty key is filtered by `buildIoSchema`. `buildIoSchema(inputs,outputs)` → `{inputs:[...clean],outputs:[...clean]}` dropping blank-key rows.
- [ ] **Implement** `ioSchemaShape.ts`:

```ts
import type { IoField } from '... or inline'; // define locally:
export const IO_TYPES = ['string', 'number', 'boolean', 'enum', 'file', 'file_list'] as const;
export type IoType = (typeof IO_TYPES)[number];
export interface IoField {
  key: string;
  type: IoType;
  label?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  maxLength?: number;
}
export function emptyIoField(): IoField {
  return { key: '', type: 'string', required: false };
}
export function cleanField(f: IoField): IoField {
  const out: IoField = { key: f.key.trim(), type: f.type, required: f.required ?? false };
  if (f.label && f.label.trim() !== '') out.label = f.label.trim();
  if (f.type === 'enum' && f.options && f.options.length > 0) out.options = f.options;
  if (
    typeof f.maxLength === 'number' &&
    f.maxLength > 0 &&
    (f.type === 'string' || f.type === 'file')
  )
    out.maxLength = f.maxLength;
  return out;
}
export function buildIoSchema(inputs: IoField[], outputs: IoField[]) {
  return {
    inputs: inputs.filter((f) => f.key.trim() !== '').map(cleanField),
    outputs: outputs.filter((f) => f.key.trim() !== '').map(cleanField),
  };
}
```

- [ ] **Implement** `IoSchemaField.tsx`: `IoSchemaField({ value?:{inputs:IoField[];outputs:IoField[]}, onChange })`. Two labelled sections (Inputs / Outputs), each a list of field rows + "add field". Each row: `key` TextField + `type` SelectField(`IO_TYPES` via toOptions) + `required` Toggle + a small "more" area for optional `label`/`maxLength` (maxLength NumberField, shown for string/file) + when `type==='enum'` a `ChipsField` for `options` (required hint). Remove-row IconButton. On change → `onChange(buildIoSchema(...))`. Each field has a `tooltip`/`hint` from §IoField hints (key/type/required/options/maxLength). Default value when empty: one input row `{key:'prompt',type:'string',required:true}` + one output `{key:'text',type:'string'}` as a friendly starting point (or empty rows — pick empty + a hint).
- [ ] Verify green. Commit `feat(web): ioschemafield inputs/outputs builder`.

## Task 7: `PricebookSpecForm` (per-method spec builder)

**Files:** `components/data/pricebookSpec.ts` (+ test), `components/data/PricebookSpecForm.tsx`.

- [ ] **Test** `pricebookSpec.test.ts`: `buildSpec` per method:
  - unit: `buildSpec('unit',{dimensions:[{name:'tokens',rate:1}]})` → `{method:'unit',dimensions:{tokens:{rate:1}}}`.
  - passthrough: `buildSpec('passthrough',{markup:{type:'percent',value:20}})` → `{method:'passthrough',markup:{type:'percent',value:20}}`.
  - formula: `buildSpec('formula',{expr:'a + b'})` → `{method:'formula',expr:'a + b'}`.
  - matrix: `buildSpec('matrix',{key:['res'],table:[{k:'720p',cell:1000}]})` → `{method:'matrix',key:['res'],table:{'720p':1000}}`.
  - fixed: `buildSpec('fixed',{})` → `{method:'fixed'}` (amount supplied by backend via fixedCredits).
  - `validateFormula('a + b*2')` → ok; `validateFormula('a / b')` / `'1.5'` / `'x%y'` → error.
- [ ] **Implement** `pricebookSpec.ts`:

```ts
import type { PricebookMethod } from '../../lib/api/types';
export interface SpecFormState {
  dimensions: { name: string; rate: number }[]; // unit
  expr: string; // formula
  key: string[]; // matrix
  table: { k: string; cell: number }[]; // matrix
  multiplier: string;
  perItem: string; // matrix (optional)
  markup: { enabled: boolean; type: 'percent' | 'flat'; value: number }; // passthrough
}
export function emptySpecForm(): SpecFormState {
  return {
    dimensions: [{ name: '', rate: 0 }],
    expr: '',
    key: [],
    table: [],
    multiplier: '',
    perItem: '',
    markup: { enabled: false, type: 'percent', value: 0 },
  };
}
export function validateFormula(expr: string): boolean {
  // only digits, identifiers, + - * ( ) and spaces
  return expr.trim() !== '' && /^[\sA-Za-z0-9_+\-*()]+$/.test(expr) && !/[/%.]/.test(expr);
}
export function buildSpec(method: PricebookMethod, s: SpecFormState): Record<string, unknown> {
  switch (method) {
    case 'unit': {
      const dimensions: Record<string, { rate: number }> = {};
      for (const d of s.dimensions)
        if (d.name.trim() !== '') dimensions[d.name.trim()] = { rate: d.rate };
      return { method: 'unit', dimensions };
    }
    case 'matrix': {
      const table: Record<string, number> = {};
      for (const row of s.table) if (row.k.trim() !== '') table[row.k.trim()] = row.cell;
      const out: Record<string, unknown> = { method: 'matrix', key: s.key, table };
      if (s.multiplier.trim() !== '') out.multiplier = s.multiplier.trim();
      if (s.perItem.trim() !== '') out.perItem = s.perItem.trim();
      return out;
    }
    case 'formula':
      return { method: 'formula', expr: s.expr.trim() };
    case 'passthrough':
      return s.markup.enabled
        ? { method: 'passthrough', markup: { type: s.markup.type, value: s.markup.value } }
        : { method: 'passthrough' };
    case 'fixed':
    default:
      return { method }; // fixed amount comes from fixedCredits
  }
}
```

- [ ] **Implement** `PricebookSpecForm.tsx`: `PricebookSpecForm({ method, value:SpecFormState, onChange })` renders the branch for `method` with full descriptions (µcredits gotcha in hints/tooltips):
  - `unit`: rows `{name TextField, rate NumberField(min 0)}` + "add dimension"; hint "rate = µcredits per unit (1 credit = 1,000,000 µcredits)".
  - `matrix`: `key` ChipsField + table rows `{k TextField (joined key, '|' for multi), cell NumberField µcredits}` + optional `multiplier`/`perItem` TextFields; tooltip explaining the joined key.
  - `formula`: single `TextField` for `expr` with live `validateFormula` error + hint listing allowed ops; (variable names come from request params).
  - `passthrough`: a `Toggle` "add markup" → `{type SelectField(MARKUP_TYPES), value NumberField}` (percent=whole %, flat=µcredits).
  - `fixed`: a note "set the price via Fixed credits below" (the `fixedCredits` field lives in the pricing modal, Task in 1b).
    The parent (1b) keeps `SpecFormState` + the chosen `method`; calls `buildSpec(method, state)` on submit.
- [ ] Verify green. Commit `feat(web): pricebookspecform per-method spec builder`.

## Task 8: i18n for toolkit labels

**Files:** both `console.json`.

- [ ] Add a `forms.*` block (both locales) for the toolkit: add-row/add-field/add-dimension/remove labels, key/value placeholders, options label, enum-options hint, "advanced JSON" toggle label (unused now but reserved), and the IoField + spec field labels/hints/tooltips referenced in Tasks 6–7 (e.g. `forms.io.key`, `forms.io.type`, `forms.io.required`, `forms.io.options`, `forms.io.maxLength`, `forms.spec.rate`, `forms.spec.exprHint`, `forms.spec.muCreditNote`, `forms.spec.markup`, …). Keep en/zh in sync.
- [ ] Verify gate + `vitest run` green. Commit `feat(web): i18n for forms toolkit`.

## Final verification (1a checkpoint)

- [ ] Full gate + `vitest run` green (enums, kvRows, KeyValueEditor, ChipsField, Tooltip, Drawer, ioSchemaShape, pricebookSpec, IoSchemaField/PricebookSpecForm render tests).
- [ ] These are leaf components (not yet wired into a page) — verify in isolation via tests; visual wiring happens in 1b. No raw-JSON inputs introduced.

## Self-review notes

- Covers spec §4 forms toolkit. Pure shape logic (kvRows, ioSchemaShape, pricebookSpec) is unit-tested — the correctness-critical part. Components compose existing primitives + FormField (label/error/hint/**tooltip**).
- µcredit vs human-credit: only `fixedCredits` (human) lives in 1b's modal; all `spec`-internal rates are µcredits, labeled as such.
- No `ConfirmDialog` here (deferred). `matrix`/`formula` are fully formed (not raw) per the confirmed "full" scope.
