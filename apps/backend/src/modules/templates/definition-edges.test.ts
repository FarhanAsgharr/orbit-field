/**
 * Checklist validation: the malformed shapes, not the well-formed ones.
 *
 * `definition.schema.test.ts` covers what a template builder produces.
 * This covers what arrives from an import file, a hand-edited JSON body, or a
 * builder with a bug — the inputs nobody reviewed.
 *
 * Every case here is a checklist that would be *accepted* by a looser
 * validator and then fail silently in the field: a question with no options to
 * choose from, a logic rule whose operator does not exist, a repeat range that
 * can never be satisfied, a pattern that throws when the renderer compiles it.
 * None of those look wrong in the console. They look wrong to an inspector in a
 * basement, with no signal, and no way to fix it.
 */

import { describe, expect, it } from 'vitest';

import { validateDefinition } from './definition.schema.js';

/** A field that passes, so each case varies exactly one thing. */
const goodField = (over: Record<string, unknown> = {}) => ({
  key: 'ok',
  label: 'A question',
  type: 'PASS_FAIL',
  order: 0,
  options: [
    { value: 'pass', label: 'Yes', score: 1 },
    { value: 'fail', label: 'No', score: 0 },
  ],
  ...over,
});

const withFields = (fields: unknown[]) => ({
  sections: [{ title: 'Section', order: 0, fields }],
});

/** Assert failure and return the error map, so cases can name the exact path. */
function rejected(definition: unknown): Record<string, string> {
  const result = validateDefinition(definition);
  expect(result.ok).toBe(false);
  return result.ok ? {} : result.errors;
}

describe('the outer shape', () => {
  it('rejects a definition with no sections array', async () => {
    expect(rejected({ notSections: [] })['definition.sections']).toMatch(/sections/i);
  });

  it('rejects null and a primitive', async () => {
    expect(validateDefinition(null).ok).toBe(false);
    expect(validateDefinition(42).ok).toBe(false);
    expect(validateDefinition('sections').ok).toBe(false);
  });

  it('rejects an empty template', async () => {
    // A checklist with nothing in it renders as a blank form on site.
    expect(rejected({ sections: [] })['definition.sections']).toMatch(/at least one section/i);
  });

  it('rejects an implausible number of sections', async () => {
    const sections = Array.from({ length: 101 }, (_, i) => ({
      title: `S${i}`,
      order: i,
      fields: [goodField()],
    }));
    expect(rejected({ sections })['definition.sections']).toMatch(/at most 100/i);
  });

  it('accepts a bare array of sections as well as a wrapped object', async () => {
    const result = validateDefinition([{ title: 'Section', order: 0, fields: [goodField()] }]);
    expect(result.ok).toBe(true);
  });

  it('rejects a section that is not an object', async () => {
    expect(rejected({ sections: [null] })['sections[0]']).toMatch(/must be an object/i);
  });

  it('rejects a section with no title', async () => {
    expect(
      rejected({ sections: [{ order: 0, fields: [goodField()] }] })['sections[0].title'],
    ).toMatch(/needs a title/i);
  });
});

describe('repeatable sections', () => {
  it('rejects a repeat range that can never be satisfied', async () => {
    const errors = rejected({
      sections: [
        {
          title: 'Repeating',
          order: 0,
          repeatable: true,
          repeatMinInstances: 5,
          repeatMaxInstances: 2,
          fields: [goodField()],
        },
      ],
    });
    // An inspector asked for five and allowed two can never submit.
    expect(errors['sections[0].repeatMaxInstances']).toMatch(/below the minimum/i);
  });

  it('accepts an open-ended repeat', async () => {
    const result = validateDefinition({
      sections: [
        {
          title: 'Repeating',
          order: 0,
          repeatable: true,
          repeatMinInstances: 1,
          fields: [goodField()],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe('fields', () => {
  it('rejects a field that is not an object', async () => {
    expect(rejected(withFields([null]))['sections[0].fields[0]']).toMatch(/must be an object/i);
  });

  it('rejects a duplicate question id, which would make answers ambiguous', async () => {
    const id = '01FIELD0000000000000000001';
    const errors = rejected(withFields([goodField({ id }), goodField({ id, key: 'other' })]));
    expect(Object.values(errors).some((m) => /duplicate question id/i.test(m))).toBe(true);
  });

  it('rejects a duplicate key, which silently collides in a CSV export', async () => {
    const errors = rejected(withFields([goodField({ key: 'same' }), goodField({ key: 'same' })]));
    expect(Object.values(errors).some((m) => /duplicate/i.test(m))).toBe(true);
  });

  it('rejects nesting beyond the supported depth', async () => {
    // Each level is another indent in the renderer and another frame in the
    // evaluator; twenty is an authoring mistake, not a design.
    let field: Record<string, unknown> = goodField({ key: 'deep' });
    for (let i = 0; i < 12; i++) {
      field = goodField({ key: `level${i}`, followUps: [field] });
    }
    const errors = rejected(withFields([field]));
    expect(Object.values(errors).some((m) => /nest more than 10/i.test(m))).toBe(true);
  });
});

describe('choice options', () => {
  it('rejects an option that is not an object', async () => {
    const errors = rejected(withFields([goodField({ options: ['pass'] })]));
    expect(errors['sections[0].fields[0].options[0]']).toMatch(/must be an object/i);
  });

  it('rejects an option with no stable value', async () => {
    const errors = rejected(withFields([goodField({ options: [{ label: 'Yes' }] })]));
    // Without a value there is nothing to store when somebody picks it.
    expect(errors['sections[0].fields[0].options[0].value']).toMatch(/stable value/i);
  });

  it('rejects two options sharing a value', async () => {
    const errors = rejected(
      withFields([
        goodField({
          options: [
            { value: 'same', label: 'One' },
            { value: 'same', label: 'Two' },
          ],
        }),
      ]),
    );
    expect(errors['sections[0].fields[0].options[1].value']).toMatch(/duplicate/i);
  });

  it('rejects an option with no label, which would render as a blank button', async () => {
    const errors = rejected(withFields([goodField({ options: [{ value: 'pass', label: '  ' }] })]));
    expect(errors['sections[0].fields[0].options[0].label']).toMatch(/needs a label/i);
  });

  it('rejects a non-numeric score', async () => {
    const errors = rejected(
      withFields([goodField({ options: [{ value: 'pass', label: 'Yes', score: 'high' }] })]),
    );
    expect(errors['sections[0].fields[0].options[0].score']).toMatch(/must be a number/i);
  });

  it('accepts an option with no score at all', async () => {
    const result = validateDefinition(
      withFields([goodField({ options: [{ value: 'pass', label: 'Yes' }] })]),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validation rules on a field', () => {
  it('rejects a numeric range that excludes every value', async () => {
    const errors = rejected(
      withFields([goodField({ type: 'NUMBER', options: [], validation: { min: 10, max: 1 } })]),
    );
    expect(errors['sections[0].fields[0].validation']).toMatch(/cannot exceed the maximum/i);
  });

  it('rejects a length range that excludes every value', async () => {
    const errors = rejected(
      withFields([
        goodField({ type: 'TEXT', options: [], validation: { minLength: 50, maxLength: 5 } }),
      ]),
    );
    expect(errors['sections[0].fields[0].validation']).toMatch(/minimum length/i);
  });

  it('rejects a pattern that will not compile', async () => {
    const errors = rejected(
      withFields([goodField({ type: 'TEXT', options: [], validation: { pattern: '([unclosed' } })]),
    );
    // The renderer compiles this on the device; an invalid pattern throws
    // there, where nobody can fix it.
    expect(Object.keys(errors).some((k) => k.includes('pattern'))).toBe(true);
  });

  it('accepts a valid pattern', async () => {
    const result = validateDefinition(
      withFields([
        goodField({ type: 'TEXT', options: [], validation: { pattern: '^[A-Z]{2}-\\d{4}$' } }),
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe('conditional logic', () => {
  const withLogic = (logic: unknown) =>
    withFields([goodField({ key: 'trigger' }), goodField({ key: 'target', logic })]);

  it('rejects a rule that is not an object', async () => {
    const errors = rejected(withLogic(['SHOW']));
    expect(Object.values(errors).some((m) => /must be an object/i.test(m))).toBe(true);
  });

  it('rejects an operator that does not exist', async () => {
    const errors = rejected(
      withLogic([
        {
          when: {
            kind: 'CONDITION',
            condition: { fieldId: '01FIELD0000000000000000001', operator: 'SORT_OF_EQUALS' },
          },
          effect: 'SHOW',
        },
      ]),
    );
    // An unknown operator never matches, so the question silently never appears.
    expect(Object.values(errors).some((m) => /unknown operator/i.test(m))).toBe(true);
  });

  it('rejects a condition that references no question', async () => {
    const errors = rejected(
      withLogic([
        { when: { kind: 'CONDITION', condition: { operator: 'EQUALS' } }, effect: 'SHOW' },
      ]),
    );
    expect(Object.values(errors).some((m) => /must reference a question/i.test(m))).toBe(true);
  });

  it('rejects an unknown condition group', async () => {
    const errors = rejected(withLogic([{ when: { kind: 'MAYBE', children: [] }, effect: 'SHOW' }]));
    expect(Object.values(errors).some((m) => /unknown condition group/i.test(m))).toBe(true);
  });

  it('rejects a group whose children are not a list', async () => {
    const errors = rejected(
      withLogic([{ when: { kind: 'ALL', children: 'everything' }, effect: 'SHOW' }]),
    );
    expect(Object.values(errors).some((m) => /list of conditions/i.test(m))).toBe(true);
  });

  it('rejects an effect that does not exist', async () => {
    const errors = rejected(
      withLogic([
        {
          when: {
            kind: 'CONDITION',
            condition: { fieldId: '01FIELD0000000000000000001', operator: 'EQUALS' },
          },
          effect: 'SET_ON_FIRE',
        },
      ]),
    );
    expect(Object.values(errors).some((m) => /effect/i.test(m))).toBe(true);
  });
});

describe('a definition that is valid', () => {
  it('reports what it normalised, so a caller can show the author', async () => {
    const result = validateDefinition({
      sections: [
        { title: 'One', order: 0, fields: [goodField({ key: 'a' }), goodField({ key: 'b' })] },
        { title: 'Two', order: 1, fields: [goodField({ key: 'c' })] },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sectionCount).toBe(2);
    expect(result.fieldCount).toBe(3);
  });

  it('mints fresh ids on import so two installations never share a primary key', async () => {
    const original = '01FIELD0000000000000000001';
    const definition = withFields([goodField({ id: original })]);

    const kept = validateDefinition(definition);
    const reminted = validateDefinition(definition, { remintIds: true });

    expect(kept.ok && reminted.ok).toBe(true);
    if (!kept.ok || !reminted.ok) return;

    const fieldId = (r: typeof kept) =>
      (r.normalised as { sections: { fields: { id: string }[] }[] }).sections[0]!.fields[0]!.id;

    expect(fieldId(kept)).toBe(original);
    expect(fieldId(reminted)).not.toBe(original);
  });
});
