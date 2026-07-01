import { describe, expect, it } from 'vitest';

import type { ParameterRule } from '../src/param-profile.js';
import { resolveRule } from '../src/param-profile.js';
import { PARAM_TEMPLATE_NAMES, PARAM_TEMPLATES } from '../src/param-templates.js';

describe('PARAM_TEMPLATES', () => {
  it('exposes the ten+ template names as keys', () => {
    expect(PARAM_TEMPLATE_NAMES).toContain('temperature');
    expect(PARAM_TEMPLATE_NAMES).toContain('reasoning_effort');
    expect(Object.keys(PARAM_TEMPLATES)).toEqual(PARAM_TEMPLATE_NAMES);
  });

  it('temperature template carries the OpenAI-canonical bounds', () => {
    expect(PARAM_TEMPLATES.temperature).toMatchObject({
      type: 'float',
      default: 1.0,
      min: 0,
      max: 2,
    });
  });
});

describe('resolveRule', () => {
  // R-1: useTemplate with no overrides resolves to the template row.
  it('R-1: `useTemplate:temperature` with no overrides inherits the template', () => {
    const merged = resolveRule({ name: 'temperature', useTemplate: 'temperature' });
    expect(merged).toMatchObject({
      name: 'temperature',
      type: 'float',
      default: 1.0,
      min: 0,
      max: 2,
    });
  });

  // R-2: useTemplate + a field override — the override wins, other template fields stay.
  it('R-2: a field the rule sets OVERRIDES the template; unset template fields stay', () => {
    const merged = resolveRule({ name: 'temperature', useTemplate: 'temperature', max: 1 });
    expect(merged.max).toBe(1);
    expect(merged.min).toBe(0); // template min preserved
    expect(merged.type).toBe('float');
  });

  // R-3: inline rule, no template — returned as-is.
  it('R-3: an inline rule with no template is returned unchanged', () => {
    const rule: ParameterRule = { name: 'enable_thinking', type: 'boolean', default: false };
    expect(resolveRule(rule)).toEqual(rule);
  });

  // R-4: unknown template name — ignored, rule used as-is (never throws).
  it('R-4: an unknown `useTemplate` name is ignored (rule used as-is, no throw)', () => {
    const rule: ParameterRule = { name: 'x', useTemplate: 'not_a_template', type: 'int' };
    expect(resolveRule(rule)).toEqual(rule);
  });

  // R-5: enum rule (reasoning_effort) resolves its options.
  it('R-5: `reasoning_effort` resolves the enum options from the template', () => {
    const merged = resolveRule({ name: 'reasoning_effort', useTemplate: 'reasoning_effort' });
    expect(merged.type).toBe('enum');
    expect(merged.options).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });
});
