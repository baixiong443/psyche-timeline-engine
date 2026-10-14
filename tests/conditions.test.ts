import { evaluateCondition, isSafePath, validateConditionRule } from '../src/engine/conditions';
import { createEmptyProjection } from '../src/model/defaults';
import type { JsonLogicRule } from '../src/model/types';

describe('condition validation', () => {
  it('accepts allowlisted JSON Logic and evaluates it', () => {
    const projection = createEmptyProjection('story-1');
    projection.flags.door_open = true;
    const rule: JsonLogicRule = { and: [{ '===': [{ var: 'flags.door_open' }, true] }, { '!': [{ var: 'flags.trapped' }] }] };

    expect(validateConditionRule(rule)).toMatchObject({ valid: true });
    expect(evaluateCondition(rule, projection)).toBe(true);
  });

  it('rejects unapproved operators and prototype paths', () => {
    expect(validateConditionRule({ '+': [1, 2] }).valid).toBe(false);
    expect(validateConditionRule({ var: 'flags.__proto__.polluted' }).valid).toBe(false);
    expect(isSafePath('characters.constructor.prototype')).toBe(false);
  });
});
