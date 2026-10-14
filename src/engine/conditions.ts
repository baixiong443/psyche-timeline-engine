import jsonLogic from 'json-logic-js';
import type { JsonLogicRule, JsonValue, StoryProjection } from '../model/types';

const ALLOWED_OPERATORS = new Set([
  'var', '==', '===', '!=', '!==', '>', '>=', '<', '<=', 'and', 'or', '!', 'in', 'missing'
]);
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export interface ConditionValidationResult {
  valid: boolean;
  errors: string[];
  nodeCount: number;
}

export function isSafePath(path: string): boolean {
  if (!path || path.length > 240) return false;
  return path.split('.').every(segment => segment.length > 0 && !FORBIDDEN_PATH_SEGMENTS.has(segment));
}

export function validateConditionRule(rule: JsonLogicRule | undefined, maxNodes = 200): ConditionValidationResult {
  if (rule === undefined || rule === null) return { valid: true, errors: [], nodeCount: 0 };

  const errors: string[] = [];
  let nodeCount = 0;

  const visit = (value: JsonValue, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > maxNodes) {
      errors.push(`Condition exceeds ${maxNodes} nodes.`);
      return;
    }
    if (depth > 30) {
      errors.push('Condition nesting exceeds 30 levels.');
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const keys = Object.keys(value);
    if (keys.length !== 1) {
      errors.push('Every condition object must contain exactly one operator.');
      return;
    }
    const operator = keys[0];
    if (!operator || !ALLOWED_OPERATORS.has(operator)) {
      errors.push(`Condition operator is not allowed: ${operator ?? '(missing)'}.`);
      return;
    }
    const operand = (value as Record<string, JsonValue>)[operator];
    if (operator === 'var') {
      const path = Array.isArray(operand) ? operand[0] : operand;
      if (typeof path !== 'string' || !isSafePath(path)) {
        errors.push(`Unsafe condition variable path: ${String(path)}.`);
      }
    }
    if (operand !== undefined) visit(operand, depth + 1);
  };

  visit(rule, 0);
  return { valid: errors.length === 0, errors, nodeCount };
}

export function evaluateCondition(rule: JsonLogicRule | undefined, projection: StoryProjection): boolean {
  if (rule === undefined || rule === null) return true;
  const validation = validateConditionRule(rule);
  if (!validation.valid) return false;
  try {
    return Boolean(jsonLogic.apply(rule as never, projection as never));
  } catch {
    return false;
  }
}
