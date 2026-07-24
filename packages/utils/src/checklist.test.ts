import { describe, expect, it } from 'vitest';
import {
  FieldType,
  InspectionOutcome,
  type TemplateField,
  type TemplateSection,
} from '@orbit/types';
import { evaluateForm, evaluateCondition, type AnswerMap } from './logic.js';
import { validateInspection, validateValue } from './validation.js';
import { DEFAULT_SCORING_POLICY, scoreInspection } from './scoring.js';

// --- builders --------------------------------------------------------------

let seq = 0;
const nextId = (): string => `F${++seq}`;

function field(overrides: Partial<TemplateField> & { type: FieldType }): TemplateField {
  const id = overrides.id ?? nextId();
  return {
    id: id as TemplateField['id'],
    sectionId: 'S1' as TemplateField['sectionId'],
    key: `key_${id}`,
    label: `Field ${id}`,
    order: 0,
    options: [],
    validation: {},
    ui: {},
    logic: [],
    followUps: [],
    weight: 1,
    isCritical: false,
    defaultValue: null,
    carryForward: false,
    ...overrides,
  } as TemplateField;
}

function section(fields: TemplateField[], overrides: Partial<TemplateSection> = {}): TemplateSection {
  return {
    id: 'S1' as TemplateSection['id'],
    templateVersionId: 'TV1' as TemplateSection['templateVersionId'],
    title: 'Section 1',
    description: null,
    order: 0,
    fields,
    logic: [],
    repeatable: false,
    repeatMinInstances: 1,
    repeatMaxInstances: null,
    repeatLabelTemplate: null,
    ...overrides,
  } as TemplateSection;
}

const PASS_FAIL_OPTIONS = [
  { value: 'pass', label: 'Pass', score: 1 },
  { value: 'fail', label: 'Fail', score: 0, isFailure: true },
  { value: 'na', label: 'N/A', isNotApplicable: true },
];

// --- condition evaluation --------------------------------------------------

describe('evaluateCondition', () => {
  const answers: AnswerMap = { A: 400, B: 'transformer', C: ['r', 'y'], D: '' };

  it('compares numbers across string/number representations', () => {
    expect(evaluateCondition({ fieldId: 'A' as never, operator: 'GREATER_THAN', value: '380' }, answers)).toBe(true);
    expect(evaluateCondition({ fieldId: 'A' as never, operator: 'EQUALS', value: '400' }, answers)).toBe(true);
  });

  it('does not let an unanswered question satisfy an ordering comparison', () => {
    // The dangerous default: `undefined < 5` coercing to true would reveal
    // branches that should stay hidden.
    expect(evaluateCondition({ fieldId: 'MISSING' as never, operator: 'LESS_THAN', value: 5 }, answers)).toBe(false);
    expect(evaluateCondition({ fieldId: 'MISSING' as never, operator: 'GREATER_THAN', value: -1 }, answers)).toBe(false);
  });

  it('treats an empty string as empty', () => {
    expect(evaluateCondition({ fieldId: 'D' as never, operator: 'IS_EMPTY' }, answers)).toBe(true);
    expect(evaluateCondition({ fieldId: 'B' as never, operator: 'IS_NOT_EMPTY' }, answers)).toBe(true);
  });

  it('CONTAINS works for both arrays and substrings', () => {
    expect(evaluateCondition({ fieldId: 'C' as never, operator: 'CONTAINS', value: 'y' }, answers)).toBe(true);
    expect(evaluateCondition({ fieldId: 'B' as never, operator: 'CONTAINS', value: 'FORM' }, answers)).toBe(true);
  });

  it('fails closed on a malformed regex instead of throwing', () => {
    expect(
      evaluateCondition({ fieldId: 'B' as never, operator: 'MATCHES_REGEX', value: '([' }, answers),
    ).toBe(false);
  });
});

// --- form evaluation -------------------------------------------------------

describe('evaluateForm', () => {
  it('hides a field when its HIDE rule fires', () => {
    const trigger = field({ id: 'T1', type: FieldType.YES_NO, options: [
      { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' },
    ] });
    const dependent = field({
      id: 'D1',
      type: FieldType.TEXT,
      validation: { required: true },
      logic: [{ id: 'r1', when: { kind: 'CONDITION', condition: { fieldId: 'T1' as never, operator: 'EQUALS', value: 'no' } }, effect: { type: 'HIDE' } }],
    });

    const result = evaluateForm([section([trigger, dependent])], { T1: 'no' });
    expect(result.fields.D1!.visible).toBe(false);
    // Critically: a hidden field must also stop being required.
    expect(result.fields.D1!.required).toBe(false);
  });

  it('cascades hiding from a section to its fields', () => {
    const f = field({ id: 'X1', type: FieldType.TEXT, validation: { required: true } });
    const s = section([f], {
      logic: [{ id: 's1', when: { kind: 'ALL', children: [] }, effect: { type: 'HIDE' } }],
    });

    const result = evaluateForm([s], {});
    expect(result.sections.S1!.visible).toBe(false);
    expect(result.fields.X1!.visible).toBe(false);
    expect(result.fields.X1!.required).toBe(false);
  });

  it('reveals follow-ups only when the parent rule fires', () => {
    const followUp = field({ id: 'FU1', type: FieldType.TEXT_AREA, validation: { required: true } });
    const parent = field({
      id: 'P1',
      type: FieldType.PASS_FAIL,
      options: PASS_FAIL_OPTIONS,
      followUps: [followUp],
      logic: [{
        id: 'r1',
        when: { kind: 'CONDITION', condition: { fieldId: 'P1' as never, operator: 'EQUALS', value: 'fail' } },
        effect: { type: 'REVEAL_FOLLOW_UPS' },
      }],
    });

    const passing = evaluateForm([section([parent])], { P1: 'pass' });
    expect(passing.fields.FU1!.visible).toBe(false);

    const failing = evaluateForm([section([parent])], { P1: 'fail' });
    expect(failing.fields.FU1!.visible).toBe(true);
    expect(failing.fields.FU1!.required).toBe(true);
  });

  it('collects BLOCK_SUBMIT messages only from visible fields', () => {
    const blocked = field({
      id: 'B1',
      type: FieldType.NUMBER,
      logic: [
        { id: 'r1', when: { kind: 'CONDITION', condition: { fieldId: 'B1' as never, operator: 'GREATER_THAN', value: 100 } }, effect: { type: 'BLOCK_SUBMIT', message: 'Reading exceeds safe limit.' } },
        { id: 'r2', when: { kind: 'CONDITION', condition: { fieldId: 'HIDE_ME' as never, operator: 'EQUALS', value: 'yes' } }, effect: { type: 'HIDE' } },
      ],
    });

    expect(evaluateForm([section([blocked])], { B1: 150 }).blockers).toEqual(['Reading exceeds safe limit.']);
    // Once hidden, the same field must stop blocking submission.
    expect(evaluateForm([section([blocked])], { B1: 150, HIDE_ME: 'yes' }).blockers).toEqual([]);
  });

  it('applies ALL/ANY nesting correctly', () => {
    const target = field({
      id: 'N1',
      type: FieldType.TEXT,
      logic: [{
        id: 'r1',
        when: {
          kind: 'ANY',
          children: [
            { kind: 'ALL', children: [
              { kind: 'CONDITION', condition: { fieldId: 'V' as never, operator: 'GREATER_THAN', value: 400 } },
              { kind: 'CONDITION', condition: { fieldId: 'PH' as never, operator: 'IN', value: ['R', 'Y'] } },
            ] },
            { kind: 'CONDITION', condition: { fieldId: 'EMG' as never, operator: 'EQUALS', value: 'yes' } },
          ],
        },
        effect: { type: 'REQUIRE' },
      }],
    });

    expect(evaluateForm([section([target])], { V: 500, PH: 'R' }).fields.N1!.required).toBe(true);
    expect(evaluateForm([section([target])], { V: 500, PH: 'B' }).fields.N1!.required).toBe(false);
    expect(evaluateForm([section([target])], { EMG: 'yes' }).fields.N1!.required).toBe(true);
  });
});

// --- validation ------------------------------------------------------------

describe('validateValue', () => {
  it('enforces required only when a value is actually blank', () => {
    const f = field({ type: FieldType.TEXT, validation: { required: true } });
    expect(validateValue(f, '   ').map((i) => i.code)).toEqual(['REQUIRED']);
    expect(validateValue(f, 'ok')).toHaveLength(0);
  });

  it('validates numeric step without float drift', () => {
    const f = field({ type: FieldType.NUMBER, validation: { min: 0, step: 0.1 } });
    // 0.3 is not exactly representable; a naive `% 0.1` test rejects it.
    expect(validateValue(f, 0.3)).toHaveLength(0);
    expect(validateValue(f, 0.35).map((i) => i.code)).toContain('STEP');
  });

  it('rejects unknown option values', () => {
    const f = field({ type: FieldType.DROPDOWN, options: PASS_FAIL_OPTIONS });
    expect(validateValue(f, 'maybe').map((i) => i.code)).toEqual(['INVALID_OPTION']);
    expect(validateValue(f, 'pass')).toHaveLength(0);
  });

  it('enforces multi-select bounds and rejects duplicates', () => {
    const f = field({
      type: FieldType.MULTI_SELECT,
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      validation: { minSelections: 2 },
    });
    expect(validateValue(f, ['a']).map((i) => i.code)).toContain('TOO_FEW_SELECTED');
    expect(validateValue(f, ['a', 'a']).map((i) => i.code)).toContain('DUPLICATE_SELECTION');
    expect(validateValue(f, ['a', 'b'])).toHaveLength(0);
  });

  it('rejects a mocked GPS fix outright', () => {
    const f = field({ type: FieldType.GPS, validation: { required: true } });
    const mocked = { latitude: 24.7, longitude: 46.7, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null, capturedAt: '2026-07-24T10:00:00.000Z', mocked: true };
    expect(validateValue(f, mocked as never).map((i) => i.code)).toContain('LOCATION_MOCKED');
  });

  it('treats an inaccurate fix as a warning, not a hard failure', () => {
    const f = field({ type: FieldType.GPS, validation: { requiredGpsAccuracyMeters: 10 } });
    const rough = { latitude: 24.7, longitude: 46.7, accuracy: 80, altitude: null, altitudeAccuracy: null, heading: null, speed: null, capturedAt: '2026-07-24T10:00:00.000Z', mocked: false };
    const issues = validateValue(f, rough as never);
    expect(issues[0]!.code).toBe('LOCATION_INACCURATE');
    expect(issues[0]!.severity).toBe('WARNING');
  });

  it('requires at least one attachment on a required photo field', () => {
    const f = field({ type: FieldType.PHOTO, validation: { required: true } });
    expect(validateValue(f, null, { attachments: [] }).map((i) => i.code)).toEqual(['ATTACHMENT_REQUIRED']);
  });
});

describe('validateInspection', () => {
  it('does not block submission on a question the inspector never saw', () => {
    const hidden = field({
      id: 'H1',
      type: FieldType.TEXT,
      validation: { required: true },
      logic: [{ id: 'r', when: { kind: 'CONDITION', condition: { fieldId: 'G1' as never, operator: 'EQUALS', value: 'no' } }, effect: { type: 'HIDE' } }],
    });
    const gate = field({ id: 'G1', type: FieldType.YES_NO, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] });

    const outcome = validateInspection({ sections: [section([gate, hidden])], answers: { G1: 'no' } });
    expect(outcome.valid).toBe(true);
    expect(outcome.errors).toHaveLength(0);
  });

  it('reports the visible required question that is genuinely missing', () => {
    const f = field({ id: 'R1', type: FieldType.TEXT, validation: { required: true } });
    const outcome = validateInspection({ sections: [section([f])], answers: {} });
    expect(outcome.valid).toBe(false);
    expect(outcome.errors[0]!.code).toBe('REQUIRED');
    expect(outcome.errors[0]!.fieldId).toBe('R1');
  });

  it('honours a REQUIRE effect that overrides an optional template rule', () => {
    const f = field({
      id: 'O1',
      type: FieldType.TEXT,
      validation: { required: false },
      logic: [{ id: 'r', when: { kind: 'ALL', children: [] }, effect: { type: 'REQUIRE' } }],
    });
    const outcome = validateInspection({ sections: [section([f])], answers: {} });
    expect(outcome.errors.map((e) => e.code)).toEqual(['REQUIRED']);
  });
});

// --- scoring ---------------------------------------------------------------

describe('scoreInspection', () => {
  const mk = (id: string, extra: Partial<TemplateField> = {}) =>
    field({ id, type: FieldType.PASS_FAIL, options: PASS_FAIL_OPTIONS, ...extra });

  it('computes a weighted percentage', () => {
    const s = section([mk('Q1'), mk('Q2'), mk('Q3')]);
    const result = scoreInspection({
      sections: [s],
      answers: { Q1: 'pass', Q2: 'pass', Q3: 'fail' },
      policy: DEFAULT_SCORING_POLICY,
    });

    expect(result.earned).toBe(2);
    expect(result.possible).toBe(3);
    expect(result.percentage).toBeCloseTo(66.67, 1);
    expect(result.failedFields).toBe(1);
  });

  it('respects field weight', () => {
    const s = section([mk('W1', { weight: 3 }), mk('W2', { weight: 1 })]);
    const result = scoreInspection({
      sections: [s],
      answers: { W1: 'pass', W2: 'fail' },
      policy: DEFAULT_SCORING_POLICY,
    });
    expect(result.earned).toBe(3);
    expect(result.possible).toBe(4);
    expect(result.percentage).toBe(75);
  });

  it('removes N/A answers from the denominator rather than scoring them zero', () => {
    const s = section([mk('N1'), mk('N2')]);
    const result = scoreInspection({
      sections: [s],
      answers: { N1: 'pass', N2: 'na' },
      policy: DEFAULT_SCORING_POLICY,
    });
    expect(result.possible).toBe(1);
    expect(result.percentage).toBe(100);
    expect(result.notApplicableFields).toBe(1);
  });

  it('excludes questions hidden by conditional logic from the denominator', () => {
    // An inspector who answers "no transformer on site" must not be penalised
    // for the transformer questions that were never shown.
    const hidden = mk('HQ', {
      logic: [{ id: 'r', when: { kind: 'CONDITION', condition: { fieldId: 'GATE' as never, operator: 'EQUALS', value: 'no' } }, effect: { type: 'HIDE' } }],
    });
    const gate = field({ id: 'GATE', type: FieldType.YES_NO, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] });
    const visible = mk('VQ');

    const result = scoreInspection({
      sections: [section([gate, visible, hidden])],
      answers: { GATE: 'no', VQ: 'pass', HQ: 'fail' },
      policy: DEFAULT_SCORING_POLICY,
    });

    expect(result.percentage).toBe(100);
    expect(result.failedFields).toBe(0);
  });

  it('a critical failure forces FAIL regardless of the percentage', () => {
    const s = section([
      mk('C1', { isCritical: true }),
      ...Array.from({ length: 9 }, (_, i) => mk(`P${i}`)),
    ]);
    const answers: AnswerMap = { C1: 'fail' };
    for (let i = 0; i < 9; i++) answers[`P${i}`] = 'pass';

    const result = scoreInspection({ sections: [s], answers, policy: DEFAULT_SCORING_POLICY });
    expect(result.percentage).toBe(90);
    expect(result.criticalFailures).toBe(1);
    expect(result.outcome).toBe(InspectionOutcome.FAIL);
  });

  it('downgrades a passing score to PASS_WITH_OBSERVATIONS when any answer failed', () => {
    const s = section(Array.from({ length: 10 }, (_, i) => mk(`Q${i}`)));
    const answers: AnswerMap = {};
    for (let i = 0; i < 10; i++) answers[`Q${i}`] = i === 0 ? 'fail' : 'pass';

    const result = scoreInspection({ sections: [s], answers, policy: DEFAULT_SCORING_POLICY });
    expect(result.percentage).toBe(90);
    expect(result.outcome).toBe(InspectionOutcome.PASS_WITH_OBSERVATIONS);
  });

  it('returns PENDING when nothing scoreable has been answered', () => {
    const result = scoreInspection({
      sections: [section([mk('Q1')])],
      answers: {},
      policy: DEFAULT_SCORING_POLICY,
    });
    expect(result.percentage).toBeNull();
    expect(result.outcome).toBe(InspectionOutcome.PENDING);
  });

  it('scores a numeric field by whether it falls inside the acceptable band', () => {
    const f = field({ id: 'NUM', type: FieldType.NUMBER, validation: { min: 0, max: 5 } });
    const inBand = scoreInspection({ sections: [section([f])], answers: { NUM: 3 }, policy: DEFAULT_SCORING_POLICY });
    expect(inBand.percentage).toBe(100);

    const outOfBand = scoreInspection({ sections: [section([f])], answers: { NUM: 9 }, policy: DEFAULT_SCORING_POLICY });
    expect(outOfBand.percentage).toBe(0);
    expect(outOfBand.failedFields).toBe(1);
  });
});
