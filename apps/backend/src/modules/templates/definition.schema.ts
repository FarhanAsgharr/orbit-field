/**
 * Checklist definition validation.
 *
 * A template definition arrives as free-form JSON from a builder UI or an
 * import file. By the time it reaches a device it is the sole description of
 * what an inspector must answer, and there is no opportunity to fix it — they
 * are in a basement with no signal. So it is validated hard here, at the only
 * point where rejection is cheap.
 *
 * Beyond shape, this catches the two authoring mistakes that produce a
 * technically-valid-but-broken checklist:
 *
 *   - a logic rule referencing a field that does not exist, which silently
 *     never fires, so a question that should appear never does;
 *   - a circular logic dependency, where A shows B and B shows A, which makes
 *     the evaluator's output depend on iteration order.
 */

import { FieldType } from '@orbit/types';
import { toDisplayString, ulid } from '@orbit/utils';

export interface ValidationSuccess {
  ok: true;
  /** Definition with ids filled in and ordering normalised. */
  normalised: { sections: unknown[] };
  fieldCount: number;
  sectionCount: number;
}

export interface ValidationFailure {
  ok: false;
  errors: Record<string, string>;
}

export type DefinitionValidation = ValidationSuccess | ValidationFailure;

const VALID_FIELD_TYPES = new Set<string>(Object.values(FieldType));

const VALID_OPERATORS = new Set([
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'CONTAINS',
  'NOT_CONTAINS',
  'IN',
  'NOT_IN',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
  'MATCHES_REGEX',
]);

const VALID_EFFECTS = new Set([
  'SHOW',
  'HIDE',
  'REQUIRE',
  'OPTIONAL',
  'DISABLE',
  'SET_VALUE',
  'WARN',
  'BLOCK_SUBMIT',
  'REVEAL_FOLLOW_UPS',
]);

interface RawField {
  id?: string;
  sectionId?: string;
  key?: string;
  label?: unknown;
  type?: unknown;
  order?: unknown;
  options?: unknown;
  validation?: unknown;
  ui?: unknown;
  logic?: unknown;
  followUps?: unknown;
  weight?: unknown;
  isCritical?: unknown;
  defaultValue?: unknown;
  carryForward?: unknown;
}

interface RawSection {
  id?: string;
  title?: unknown;
  description?: unknown;
  order?: unknown;
  fields?: unknown;
  logic?: unknown;
  repeatable?: unknown;
  repeatMinInstances?: unknown;
  repeatMaxInstances?: unknown;
  repeatLabelTemplate?: unknown;
}

export interface ValidateOptions {
  /** Mint fresh ids rather than trusting the document's. Used on import. */
  remintIds?: boolean;
}

export function validateDefinition(
  input: unknown,
  options: ValidateOptions = {},
): DefinitionValidation {
  const errors: Record<string, string> = {};

  if (input === null || typeof input !== 'object') {
    return {
      ok: false,
      errors: { definition: 'The definition must be an object with a "sections" array.' },
    };
  }

  // Accept both the wrapped and bare shapes — early exports used a bare array.
  const rawSections: unknown = Array.isArray(input)
    ? input
    : (input as { sections?: unknown }).sections;

  if (!Array.isArray(rawSections)) {
    return {
      ok: false,
      errors: { 'definition.sections': 'A definition must contain a "sections" array.' },
    };
  }
  if (rawSections.length === 0) {
    return {
      ok: false,
      errors: { 'definition.sections': 'A template must contain at least one section.' },
    };
  }
  if (rawSections.length > 100) {
    return {
      ok: false,
      errors: { 'definition.sections': 'A template may contain at most 100 sections.' },
    };
  }

  const seenFieldIds = new Set<string>();
  const seenKeys = new Set<string>();
  const declaredFieldIds = new Set<string>();
  /** field id → ids it references in its logic, for the cycle check. */
  const dependencies = new Map<string, Set<string>>();
  const idRemap = new Map<string, string>();

  let fieldCount = 0;

  /** Pass 1: shape, ids, and dependency collection. */
  function walkField(
    raw: unknown,
    sectionId: string,
    path: string,
    depth: number,
  ): RawField | null {
    if (raw === null || typeof raw !== 'object') {
      errors[path] = 'Each field must be an object.';
      return null;
    }
    const field = raw as RawField;

    // Depth is bounded because the renderer indents per level and the evaluator
    // recurses; twenty levels of nesting is an authoring error, not a design.
    if (depth > 10) {
      errors[path] = 'Follow-up questions may not nest more than 10 levels deep.';
      return null;
    }

    if (typeof field.label !== 'string' || field.label.trim() === '') {
      errors[`${path}.label`] = 'Every question needs a label.';
    }
    if (typeof field.type !== 'string' || !VALID_FIELD_TYPES.has(field.type)) {
      errors[`${path}.type`] = `Unknown question type "${String(field.type)}".`;
    }

    // Any non-empty provided id is recorded in the remap, even one we are about
    // to replace. A definition authored by hand or exported by an older build
    // may carry ids that are not 26-character ULIDs; reminting those without
    // remapping their logic references would silently sever every conditional
    // rule in the template — the failure mode this validator exists to catch.
    const providedId =
      typeof field.id === 'string' && field.id.trim() !== '' ? field.id.trim() : null;
    const id = options.remintIds || !providedId || providedId.length !== 26 ? ulid() : providedId;
    if (providedId) idRemap.set(providedId, id);

    if (seenFieldIds.has(id)) {
      errors[`${path}.id`] = 'Duplicate question id within this template.';
    }
    seenFieldIds.add(id);
    declaredFieldIds.add(id);

    const key =
      typeof field.key === 'string' && field.key.trim() ? field.key.trim() : `field_${fieldCount}`;
    if (seenKeys.has(key)) {
      // Keys appear in CSV exports and integrations, where a duplicate silently
      // overwrites a column.
      errors[`${path}.key`] =
        `Duplicate field key "${key}". Keys must be unique — they are used in exports and integrations.`;
    }
    seenKeys.add(key);

    // --- options ---
    const options_ = Array.isArray(field.options) ? field.options : [];
    const seenOptionValues = new Set<string>();
    for (const [i, option] of options_.entries()) {
      if (option === null || typeof option !== 'object') {
        errors[`${path}.options[${i}]`] = 'Each option must be an object.';
        continue;
      }
      const o = option as { value?: unknown; label?: unknown; score?: unknown };
      if (typeof o.value !== 'string' || o.value === '') {
        errors[`${path}.options[${i}].value`] = 'Each option needs a stable value.';
      } else if (seenOptionValues.has(o.value)) {
        errors[`${path}.options[${i}].value`] = `Duplicate option value "${o.value}".`;
      } else {
        seenOptionValues.add(o.value);
      }
      if (typeof o.label !== 'string' || o.label.trim() === '') {
        errors[`${path}.options[${i}].label`] = 'Each option needs a label.';
      }
      if (o.score !== undefined && o.score !== null && typeof o.score !== 'number') {
        errors[`${path}.options[${i}].score`] = 'Option score must be a number.';
      }
    }

    const choiceTypes: readonly string[] = [
      FieldType.RADIO,
      FieldType.DROPDOWN,
      FieldType.MULTI_SELECT,
      FieldType.PASS_FAIL,
      FieldType.YES_NO,
    ];
    if (
      typeof field.type === 'string' &&
      choiceTypes.includes(field.type) &&
      options_.length === 0
    ) {
      errors[`${path}.options`] = `A ${field.type} question must offer at least one option.`;
    }

    // --- validation rules ---
    const rules = (field.validation ?? {}) as Record<string, unknown>;
    if (typeof rules.min === 'number' && typeof rules.max === 'number' && rules.min > rules.max) {
      errors[`${path}.validation`] = 'The minimum value cannot exceed the maximum.';
    }
    if (
      typeof rules.minLength === 'number' &&
      typeof rules.maxLength === 'number' &&
      rules.minLength > rules.maxLength
    ) {
      errors[`${path}.validation`] = 'The minimum length cannot exceed the maximum.';
    }
    if (typeof rules.pattern === 'string') {
      try {
        new RegExp(rules.pattern);
      } catch {
        // A malformed pattern would fail closed at runtime and silently block
        // an answer the inspector cannot correct.
        errors[`${path}.validation.pattern`] = 'That is not a valid regular expression.';
      }
    }

    // --- logic ---
    const logic = Array.isArray(field.logic) ? field.logic : [];
    const deps = new Set<string>();
    for (const [i, rule] of logic.entries()) {
      collectRule(rule, `${path}.logic[${i}]`, deps);
    }
    dependencies.set(id, deps);

    // --- follow-ups ---
    const followUps = Array.isArray(field.followUps) ? field.followUps : [];
    const normalisedFollowUps: RawField[] = [];
    for (const [i, child] of followUps.entries()) {
      const result = walkField(child, sectionId, `${path}.followUps[${i}]`, depth + 1);
      if (result) normalisedFollowUps.push(result);
    }

    fieldCount += 1;

    return {
      id,
      sectionId,
      key,
      label: toDisplayString(field.label),
      type: field.type,
      order: typeof field.order === 'number' ? field.order : fieldCount,
      options: options_,
      validation: rules,
      ui: (field.ui ?? {}) as Record<string, unknown>,
      logic,
      followUps: normalisedFollowUps,
      weight: typeof field.weight === 'number' && field.weight > 0 ? field.weight : 1,
      isCritical: field.isCritical === true,
      defaultValue: field.defaultValue ?? null,
      carryForward: field.carryForward === true,
    };
  }

  function collectRule(rule: unknown, path: string, deps: Set<string>): void {
    if (rule === null || typeof rule !== 'object') {
      errors[path] = 'Each logic rule must be an object.';
      return;
    }
    const r = rule as { when?: unknown; effect?: unknown };

    const effect = r.effect as { type?: unknown } | undefined;
    if (!effect || typeof effect.type !== 'string' || !VALID_EFFECTS.has(effect.type)) {
      errors[`${path}.effect`] = `Unknown logic effect "${String(effect?.type)}".`;
    }
    if (effect?.type === 'WARN' || effect?.type === 'BLOCK_SUBMIT') {
      const message = (effect as { message?: unknown }).message;
      if (typeof message !== 'string' || message.trim() === '') {
        errors[`${path}.effect.message`] =
          'A warning or blocking rule must carry a message for the inspector.';
      }
    }

    collectNode(r.when, `${path}.when`, deps);
  }

  function collectNode(node: unknown, path: string, deps: Set<string>): void {
    if (node === null || typeof node !== 'object') {
      errors[path] = 'A logic condition is required.';
      return;
    }
    const n = node as { kind?: unknown; condition?: unknown; children?: unknown };

    if (n.kind === 'CONDITION') {
      const condition = n.condition as { fieldId?: unknown; operator?: unknown } | undefined;
      if (!condition || typeof condition.fieldId !== 'string') {
        errors[`${path}.condition.fieldId`] = 'A condition must reference a question.';
        return;
      }
      if (typeof condition.operator !== 'string' || !VALID_OPERATORS.has(condition.operator)) {
        errors[`${path}.condition.operator`] = `Unknown operator "${String(condition.operator)}".`;
      }
      deps.add(condition.fieldId);
      return;
    }

    if (n.kind === 'ALL' || n.kind === 'ANY' || n.kind === 'NONE') {
      if (!Array.isArray(n.children)) {
        errors[`${path}.children`] = `A ${n.kind} group must contain a list of conditions.`;
        return;
      }
      for (const [i, child] of n.children.entries()) {
        collectNode(child, `${path}.children[${i}]`, deps);
      }
      return;
    }

    errors[`${path}.kind`] = `Unknown condition group "${String(n.kind)}".`;
  }

  // --- walk sections ------------------------------------------------------
  const normalisedSections: unknown[] = [];

  for (const [i, raw] of rawSections.entries()) {
    if (raw === null || typeof raw !== 'object') {
      errors[`sections[${i}]`] = 'Each section must be an object.';
      continue;
    }
    const section = raw as RawSection;

    if (typeof section.title !== 'string' || section.title.trim() === '') {
      errors[`sections[${i}].title`] = 'Every section needs a title.';
    }

    const providedSectionId =
      typeof section.id === 'string' && section.id.trim() !== '' ? section.id.trim() : null;
    const sectionId =
      options.remintIds || !providedSectionId || providedSectionId.length !== 26
        ? ulid()
        : providedSectionId;
    if (providedSectionId) idRemap.set(providedSectionId, sectionId);

    const rawFields = Array.isArray(section.fields) ? section.fields : [];
    const fields: RawField[] = [];
    for (const [j, field] of rawFields.entries()) {
      const result = walkField(field, sectionId, `sections[${i}].fields[${j}]`, 0);
      if (result) fields.push(result);
    }

    const sectionDeps = new Set<string>();
    const sectionLogic = Array.isArray(section.logic) ? section.logic : [];
    for (const [j, rule] of sectionLogic.entries()) {
      collectRule(rule, `sections[${i}].logic[${j}]`, sectionDeps);
    }
    dependencies.set(sectionId, sectionDeps);

    const repeatMin =
      typeof section.repeatMinInstances === 'number' ? section.repeatMinInstances : 1;
    const repeatMax =
      typeof section.repeatMaxInstances === 'number' ? section.repeatMaxInstances : null;
    if (repeatMax !== null && repeatMax < repeatMin) {
      errors[`sections[${i}].repeatMaxInstances`] =
        'The maximum repeat count cannot be below the minimum.';
    }

    normalisedSections.push({
      id: sectionId,
      templateVersionId: '',
      title: toDisplayString(section.title),
      description: typeof section.description === 'string' ? section.description : null,
      order: typeof section.order === 'number' ? section.order : i,
      fields,
      logic: sectionLogic,
      repeatable: section.repeatable === true,
      repeatMinInstances: repeatMin,
      repeatMaxInstances: repeatMax,
      repeatLabelTemplate:
        typeof section.repeatLabelTemplate === 'string' ? section.repeatLabelTemplate : null,
    });
  }

  // --- pass 2: referential integrity -------------------------------------
  // Ids may have been reminted, so references are resolved against the remap.
  for (const [ownerId, deps] of dependencies) {
    for (const dep of deps) {
      const resolved = idRemap.get(dep) ?? dep;
      if (!declaredFieldIds.has(resolved)) {
        // This is the failure mode that produces a checklist which looks fine
        // in the builder and quietly never reveals a question in the field.
        errors[`logic.${ownerId}`] =
          `A logic rule references question "${dep}", which does not exist in this template.`;
      }
    }
  }

  // --- pass 3: dependency cycles -----------------------------------------
  const CYCLE_WHITE = 0;
  const CYCLE_GREY = 1;
  const CYCLE_BLACK = 2;
  const colour = new Map<string, number>();

  function visit(node: string, trail: string[]): boolean {
    const state = colour.get(node) ?? CYCLE_WHITE;
    if (state === CYCLE_GREY) {
      errors['logic.cycle'] =
        `Circular logic detected: ${[...trail, node].join(' → ')}. Each rule must depend only on questions resolved before it.`;
      return true;
    }
    if (state === CYCLE_BLACK) return false;

    colour.set(node, CYCLE_GREY);
    for (const dep of dependencies.get(node) ?? []) {
      const resolved = idRemap.get(dep) ?? dep;
      // A self-reference is legitimate — "hide this field when its own answer
      // is X" is a common and valid pattern.
      if (resolved === node) continue;
      if (dependencies.has(resolved) && visit(resolved, [...trail, node])) return true;
    }
    colour.set(node, CYCLE_BLACK);
    return false;
  }

  for (const node of dependencies.keys()) {
    if ((colour.get(node) ?? CYCLE_WHITE) === CYCLE_WHITE) visit(node, []);
  }

  if (Object.keys(errors).length > 0) {
    // Cap the payload: a badly broken import can produce hundreds of errors and
    // the first twenty are enough to act on.
    const capped = Object.fromEntries(Object.entries(errors).slice(0, 20));
    if (Object.keys(errors).length > 20) {
      capped['_summary'] = `${Object.keys(errors).length} problems found; showing the first 20.`;
    }
    return { ok: false, errors: capped };
  }

  return {
    ok: true,
    normalised: { sections: normalisedSections },
    fieldCount,
    sectionCount: normalisedSections.length,
  };
}
