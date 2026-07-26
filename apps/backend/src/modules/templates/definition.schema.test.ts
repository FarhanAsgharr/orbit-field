import { describe, expect, it } from 'vitest';

import { validateDefinition } from './definition.schema.js';

/** Minimal valid field. */
function field(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01JFIELD00000000000000001',
    key: 'k1',
    label: 'A question',
    type: 'TEXT',
    options: [],
    validation: {},
    ui: {},
    logic: [],
    followUps: [],
    ...overrides,
  };
}

function definition(
  fields: Array<Record<string, unknown>>,
  sectionOverrides: Record<string, unknown> = {},
) {
  return {
    sections: [
      {
        id: '01JSECTION0000000000000001',
        title: 'Section one',
        fields,
        logic: [],
        ...sectionOverrides,
      },
    ],
  };
}

describe('validateDefinition — shape', () => {
  it('rejects a non-object', () => {
    expect(validateDefinition(null).ok).toBe(false);
    expect(validateDefinition('nope').ok).toBe(false);
  });

  it('rejects a definition with no sections', () => {
    const result = validateDefinition({ sections: [] });
    expect(result.ok).toBe(false);
  });

  it('accepts the bare-array legacy shape', () => {
    const result = validateDefinition([
      { id: '01JSECTION0000000000000001', title: 'S', fields: [field()], logic: [] },
    ]);
    expect(result.ok).toBe(true);
  });

  it('requires a label and a known type on every question', () => {
    const missingLabel = validateDefinition(definition([field({ label: '' })]));
    expect(missingLabel.ok).toBe(false);

    const badType = validateDefinition(definition([field({ type: 'TELEPATHY' })]));
    expect(badType.ok).toBe(false);
    if (!badType.ok) {
      expect(Object.values(badType.errors).join(' ')).toContain('TELEPATHY');
    }
  });

  it('requires choice questions to offer options', () => {
    const result = validateDefinition(definition([field({ type: 'DROPDOWN', options: [] })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.values(result.errors).join(' ')).toContain('at least one option');
    }
  });

  it('rejects duplicate option values within one question', () => {
    const result = validateDefinition(
      definition([
        field({
          type: 'RADIO',
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'Also A' },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate field keys — they collide in exports', () => {
    const result = validateDefinition(
      definition([
        field({ id: '01JFIELD00000000000000001', key: 'same' }),
        field({ id: '01JFIELD00000000000000002', key: 'same' }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.values(result.errors).join(' ')).toContain('Duplicate field key');
    }
  });

  it('rejects a malformed regex pattern rather than failing closed at runtime', () => {
    const result = validateDefinition(definition([field({ validation: { pattern: '([' } })]));
    expect(result.ok).toBe(false);
  });

  it('rejects inverted numeric bounds', () => {
    const result = validateDefinition(
      definition([field({ type: 'NUMBER', validation: { min: 100, max: 10 } })]),
    );
    expect(result.ok).toBe(false);
  });

  it('caps follow-up nesting depth', () => {
    let nested: Record<string, unknown> = field({ id: '01JFIELDDEEP000000000000Z' });
    for (let i = 0; i < 12; i++) {
      nested = field({
        id: `01JFIELDDEEP00000000000${String(i).padStart(2, '0')}`,
        key: `deep${i}`,
        followUps: [nested],
      });
    }
    const result = validateDefinition(definition([nested]));
    expect(result.ok).toBe(false);
  });
});

describe('validateDefinition — logic integrity', () => {
  it('accepts a rule referencing an existing question', () => {
    const result = validateDefinition(
      definition([
        field({
          id: '01JFIELD00000000000000001',
          key: 'gate',
          type: 'YES_NO',
          options: [{ value: 'y', label: 'Yes' }],
        }),
        field({
          id: '01JFIELD00000000000000002',
          key: 'dependent',
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD00000000000000001', operator: 'EQUALS', value: 'y' },
              },
              effect: { type: 'HIDE' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a rule referencing a question that does not exist', () => {
    // This is the silent killer: the rule never fires, so a question that
    // should appear never does, and nothing looks wrong in the builder.
    const result = validateDefinition(
      definition([
        field({
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: {
                  fieldId: '01JGHOST000000000000000001',
                  operator: 'EQUALS',
                  value: 'x',
                },
              },
              effect: { type: 'HIDE' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.values(result.errors).join(' ')).toContain('does not exist');
    }
  });

  it('rejects an unknown operator', () => {
    const result = validateDefinition(
      definition([
        field({
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD00000000000000001', operator: 'RESEMBLES' },
              },
              effect: { type: 'HIDE' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('requires a message on WARN and BLOCK_SUBMIT effects', () => {
    const result = validateDefinition(
      definition([
        field({
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD00000000000000001', operator: 'IS_EMPTY' },
              },
              effect: { type: 'BLOCK_SUBMIT' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.values(result.errors).join(' ')).toContain('message');
    }
  });

  it('allows a self-referencing rule', () => {
    // "Hide this field when its own answer is X" is a legitimate pattern and
    // must not be mistaken for a cycle.
    const result = validateDefinition(
      definition([
        field({
          id: '01JFIELD00000000000000001',
          type: 'YES_NO',
          options: [{ value: 'n', label: 'No' }],
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD00000000000000001', operator: 'EQUALS', value: 'n' },
              },
              effect: { type: 'DISABLE' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('detects a circular logic dependency', () => {
    // A depends on B, B depends on A. The evaluator's output would depend on
    // iteration order, which is not a defensible way to decide what an
    // inspector is asked.
    const result = validateDefinition(
      definition([
        field({
          id: '01JFIELD0000000000000000A',
          key: 'a',
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD0000000000000000B', operator: 'IS_NOT_EMPTY' },
              },
              effect: { type: 'SHOW' },
            },
          ],
        }),
        field({
          id: '01JFIELD0000000000000000B',
          key: 'b',
          logic: [
            {
              id: 'r2',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD0000000000000000A', operator: 'IS_NOT_EMPTY' },
              },
              effect: { type: 'SHOW' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.values(result.errors).join(' ')).toContain('Circular logic');
    }
  });

  it('detects a longer cycle through three questions', () => {
    const link = (id: string, dependsOn: string, key: string) =>
      field({
        id,
        key,
        logic: [
          {
            id: `r-${key}`,
            when: {
              kind: 'CONDITION',
              condition: { fieldId: dependsOn, operator: 'IS_NOT_EMPTY' },
            },
            effect: { type: 'SHOW' },
          },
        ],
      });

    const result = validateDefinition(
      definition([
        link('01JFIELD0000000000000000A', '01JFIELD0000000000000000C', 'a'),
        link('01JFIELD0000000000000000B', '01JFIELD0000000000000000A', 'b'),
        link('01JFIELD0000000000000000C', '01JFIELD0000000000000000B', 'c'),
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a valid chain that is not circular', () => {
    const result = validateDefinition(
      definition([
        field({ id: '01JFIELD0000000000000000A', key: 'a' }),
        field({
          id: '01JFIELD0000000000000000B',
          key: 'b',
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD0000000000000000A', operator: 'IS_NOT_EMPTY' },
              },
              effect: { type: 'SHOW' },
            },
          ],
        }),
        field({
          id: '01JFIELD0000000000000000C',
          key: 'c',
          logic: [
            {
              id: 'r2',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD0000000000000000B', operator: 'IS_NOT_EMPTY' },
              },
              effect: { type: 'SHOW' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('validates nested ALL/ANY groups', () => {
    const result = validateDefinition(
      definition([
        field({ id: '01JFIELD0000000000000000A', key: 'a' }),
        field({
          id: '01JFIELD0000000000000000B',
          key: 'b',
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'ANY',
                children: [
                  {
                    kind: 'CONDITION',
                    condition: {
                      fieldId: '01JFIELD0000000000000000A',
                      operator: 'EQUALS',
                      value: 1,
                    },
                  },
                  {
                    kind: 'ALL',
                    children: [
                      {
                        kind: 'CONDITION',
                        condition: {
                          fieldId: '01JFIELD0000000000000000A',
                          operator: 'GREATER_THAN',
                          value: 5,
                        },
                      },
                    ],
                  },
                ],
              },
              effect: { type: 'REQUIRE' },
            },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateDefinition — normalisation', () => {
  it('reports accurate field and section counts including follow-ups', () => {
    const result = validateDefinition(
      definition([
        field({
          id: '01JFIELD0000000000000000A',
          key: 'parent',
          followUps: [field({ id: '01JFIELD0000000000000000B', key: 'child' })],
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fieldCount).toBe(2);
      expect(result.sectionCount).toBe(1);
    }
  });

  it('fills in missing ids rather than rejecting', () => {
    const result = validateDefinition({
      sections: [{ title: 'S', fields: [{ label: 'Q', type: 'TEXT' }], logic: [] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const section = result.normalised.sections[0] as {
        id: string;
        fields: Array<{ id: string }>;
      };
      expect(section.id).toHaveLength(26);
      expect(section.fields[0]!.id).toHaveLength(26);
    }
  });

  it('remints ids on import so two installations never share primary keys', () => {
    const original = '01JFIELD00000000000000001';
    const result = validateDefinition(definition([field({ id: original })]), { remintIds: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const section = result.normalised.sections[0] as { fields: Array<{ id: string }> };
      expect(section.fields[0]!.id).not.toBe(original);
      expect(section.fields[0]!.id).toHaveLength(26);
    }
  });

  it('rewrites logic references when ids are reminted', () => {
    // If references were not remapped, every rule in an imported template would
    // point at an id that no longer exists.
    const result = validateDefinition(
      definition([
        field({ id: '01JFIELD0000000000000000A', key: 'a' }),
        field({
          id: '01JFIELD0000000000000000B',
          key: 'b',
          logic: [
            {
              id: 'r1',
              when: {
                kind: 'CONDITION',
                condition: { fieldId: '01JFIELD0000000000000000A', operator: 'IS_NOT_EMPTY' },
              },
              effect: { type: 'SHOW' },
            },
          ],
        }),
      ]),
      { remintIds: true },
    );
    expect(result.ok).toBe(true);
  });

  it('defaults weight to 1 and rejects nothing for a plain field', () => {
    const result = validateDefinition(definition([field({ weight: -5 })]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const section = result.normalised.sections[0] as { fields: Array<{ weight: number }> };
      expect(section.fields[0]!.weight).toBe(1);
    }
  });

  it('caps the number of reported errors', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      field({
        id: `01JFIELD000000000000000${String(i).padStart(2, '0')}`,
        key: `k${i}`,
        type: 'NONSENSE',
      }),
    );
    const result = validateDefinition(definition(many));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).length).toBeLessThanOrEqual(21);
      expect(result.errors._summary).toBeDefined();
    }
  });
});
