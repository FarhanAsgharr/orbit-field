/**
 * Conditional-logic evaluator for dynamic checklists.
 *
 * This runs on the device while an inspector types, and again on the server at
 * submission. Both sides must agree exactly: if the phone decides a question is
 * hidden but the server decides it was required, the inspector gets an
 * unfixable submission error in the field. That is why the evaluator lives in a
 * shared package and is pure — same input, same output, no I/O, no clock.
 */

import type {
  ComparisonOperator,
  Condition,
  ConditionNode,
  FieldId,
  JsonValue,
  LogicRule,
  TemplateField,
  TemplateSection,
} from '@orbit/types';

/** Answers keyed by `fieldId` (optionally `fieldId#repeatIndex`). */
export type AnswerMap = Record<string, JsonValue>;

/** Resolved presentation state for one field after all rules have run. */
export interface FieldState {
  visible: boolean;
  required: boolean;
  disabled: boolean;
  /** Value forced by a SET_VALUE effect, if any. */
  forcedValue: JsonValue | undefined;
  warnings: string[];
  /** Messages that must block submission while present. */
  blockers: string[];
  followUpsRevealed: boolean;
}

export interface EvaluationResult {
  fields: Record<string, FieldState>;
  sections: Record<string, { visible: boolean }>;
  /** Every blocking message across the form, for the submit-gate banner. */
  blockers: string[];
}

/** Build the key under which an answer is stored. */
export function answerKey(fieldId: string, repeatIndex = 0): string {
  return repeatIndex === 0 ? fieldId : `${fieldId}#${repeatIndex}`;
}

function isEmpty(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Coerce for comparison. Template authors type `"400"` into a builder text box
 * while the device stores a number; refusing to compare those would produce
 * rules that silently never fire, which is worse than a lenient coercion.
 */
function toComparableNumber(value: JsonValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toComparableString(value: JsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function looseEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (isEmpty(a) && isEmpty(b)) return true;

  const an = toComparableNumber(a);
  const bn = toComparableNumber(b);
  if (an !== null && bn !== null) return an === bn;

  const as = toComparableString(a);
  const bs = toComparableString(b);
  if (as !== null && bs !== null) return as === bs;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => looseEquals(item, b[i]));
  }
  return false;
}

/** Evaluate a single predicate against the current answers. */
export function evaluateCondition(
  condition: Condition,
  answers: AnswerMap,
  repeatIndex = 0,
): boolean {
  // Prefer the answer from the same repeat instance, falling back to index 0 so
  // a rule can reference a question outside the repeating block.
  const scoped = answers[answerKey(condition.fieldId, repeatIndex)];
  const actual = scoped !== undefined ? scoped : answers[condition.fieldId];
  const expected = condition.value;

  switch (condition.operator satisfies ComparisonOperator) {
    case 'IS_EMPTY':
      return isEmpty(actual);
    case 'IS_NOT_EMPTY':
      return !isEmpty(actual);
    case 'EQUALS':
      return looseEquals(actual, expected ?? null);
    case 'NOT_EQUALS':
      return !looseEquals(actual, expected ?? null);

    case 'GREATER_THAN':
    case 'GREATER_THAN_OR_EQUAL':
    case 'LESS_THAN':
    case 'LESS_THAN_OR_EQUAL': {
      const a = toComparableNumber(actual);
      const b = toComparableNumber(expected ?? null);
      // An unanswered question is not "less than 5" — an absent value must not
      // satisfy an ordering comparison, or hidden branches appear spuriously.
      if (a === null || b === null) return false;
      if (condition.operator === 'GREATER_THAN') return a > b;
      if (condition.operator === 'GREATER_THAN_OR_EQUAL') return a >= b;
      if (condition.operator === 'LESS_THAN') return a < b;
      return a <= b;
    }

    case 'CONTAINS': {
      if (Array.isArray(actual)) {
        return actual.some((item) => looseEquals(item, expected ?? null));
      }
      const hay = toComparableString(actual);
      const needle = toComparableString(expected ?? null);
      if (hay === null || needle === null) return false;
      return hay.toLowerCase().includes(needle.toLowerCase());
    }
    case 'NOT_CONTAINS':
      return !evaluateCondition({ ...condition, operator: 'CONTAINS' }, answers, repeatIndex);

    case 'IN': {
      const set = asArray(expected ?? null);
      const actuals = asArray(actual);
      if (actuals.length === 0) return false;
      return actuals.some((a) => set.some((e) => looseEquals(a, e)));
    }
    case 'NOT_IN':
      return !evaluateCondition({ ...condition, operator: 'IN' }, answers, repeatIndex);

    case 'MATCHES_REGEX': {
      const subject = toComparableString(actual);
      const pattern = toComparableString(expected ?? null);
      if (subject === null || pattern === null) return false;
      try {
        return new RegExp(pattern).test(subject);
      } catch {
        // A malformed pattern is an authoring bug. Failing closed keeps a broken
        // rule from silently hiding mandatory questions.
        return false;
      }
    }

    default:
      return false;
  }
}

/** Evaluate a boolean expression tree. */
export function evaluateNode(node: ConditionNode, answers: AnswerMap, repeatIndex = 0): boolean {
  switch (node.kind) {
    case 'CONDITION':
      return evaluateCondition(node.condition, answers, repeatIndex);
    case 'ALL':
      // An empty ALL is vacuously true, matching boolean-algebra convention.
      return node.children.every((c) => evaluateNode(c, answers, repeatIndex));
    case 'ANY':
      return node.children.some((c) => evaluateNode(c, answers, repeatIndex));
    case 'NONE':
      return !node.children.some((c) => evaluateNode(c, answers, repeatIndex));
    default:
      return false;
  }
}

function defaultFieldState(field: TemplateField): FieldState {
  return {
    visible: true,
    required: field.validation.required === true,
    disabled: false,
    forcedValue: undefined,
    warnings: [],
    blockers: [],
    followUpsRevealed: false,
  };
}

function applyRules(
  state: FieldState,
  rules: LogicRule[],
  answers: AnswerMap,
  repeatIndex: number,
): void {
  for (const rule of rules) {
    if (!evaluateNode(rule.when, answers, repeatIndex)) continue;
    switch (rule.effect.type) {
      case 'SHOW':
        state.visible = true;
        break;
      case 'HIDE':
        state.visible = false;
        break;
      case 'REQUIRE':
        state.required = true;
        break;
      case 'OPTIONAL':
        state.required = false;
        break;
      case 'DISABLE':
        state.disabled = true;
        break;
      case 'SET_VALUE':
        state.forcedValue = rule.effect.value;
        break;
      case 'WARN':
        state.warnings.push(rule.effect.message);
        break;
      case 'BLOCK_SUBMIT':
        state.blockers.push(rule.effect.message);
        break;
      case 'REVEAL_FOLLOW_UPS':
        state.followUpsRevealed = true;
        break;
    }
  }
}

/**
 * Walk every field (including nested follow-ups) and resolve its state.
 *
 * Two invariants the rest of the app depends on:
 *  - a field inside a hidden section is itself hidden and never required;
 *  - a hidden field contributes no blockers, so you cannot be stopped from
 *    submitting by a question you were never shown.
 */
export function evaluateForm(
  sections: TemplateSection[],
  answers: AnswerMap,
  repeatIndex = 0,
): EvaluationResult {
  const fields: Record<string, FieldState> = {};
  const sectionStates: Record<string, { visible: boolean }> = {};
  const blockers: string[] = [];

  const walk = (field: TemplateField, sectionVisible: boolean, parentRevealed: boolean): void => {
    const state = defaultFieldState(field);
    applyRules(state, field.logic, answers, repeatIndex);

    if (!sectionVisible || !parentRevealed) {
      state.visible = false;
    }
    if (!state.visible) {
      state.required = false;
      state.blockers = [];
      state.warnings = [];
    }

    fields[field.id] = state;
    blockers.push(...state.blockers);

    // A follow-up is reachable when the parent is visible and either explicitly
    // revealed by a rule, or the parent has no REVEAL rule at all (in which case
    // follow-ups are always shown — authors use this for grouping).
    const parentHasRevealRule = field.logic.some((r) => r.effect.type === 'REVEAL_FOLLOW_UPS');
    const childrenReachable = state.visible && (!parentHasRevealRule || state.followUpsRevealed);

    for (const child of field.followUps) {
      walk(child, sectionVisible, childrenReachable);
    }
  };

  for (const section of sections) {
    const sectionState = { visible: true };
    for (const rule of section.logic) {
      if (!evaluateNode(rule.when, answers, repeatIndex)) continue;
      if (rule.effect.type === 'HIDE') sectionState.visible = false;
      if (rule.effect.type === 'SHOW') sectionState.visible = true;
    }
    sectionStates[section.id] = sectionState;

    for (const field of section.fields) {
      walk(field, sectionState.visible, true);
    }
  }

  return { fields, sections: sectionStates, blockers };
}

/** Flatten a section tree into a linear field list, follow-ups included. */
export function flattenFields(sections: TemplateSection[]): TemplateField[] {
  const out: TemplateField[] = [];
  const push = (field: TemplateField): void => {
    out.push(field);
    field.followUps.forEach(push);
  };
  for (const section of sections) {
    for (const field of section.fields) push(field);
  }
  return out;
}

/** Index fields by id for O(1) lookup during rendering and validation. */
export function indexFields(sections: TemplateSection[]): Map<FieldId, TemplateField> {
  const map = new Map<FieldId, TemplateField>();
  for (const field of flattenFields(sections)) map.set(field.id, field);
  return map;
}
