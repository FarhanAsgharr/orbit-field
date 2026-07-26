/**
 * Inspection scoring.
 *
 * The device computes a score so the inspector sees a live result; the server
 * recomputes it at submission and that value is authoritative. Both call this
 * function, so a discrepancy can only come from divergent inputs, never from
 * divergent arithmetic.
 */

import {
  FieldType,
  InspectionOutcome,
  type JsonValue,
  SCOREABLE_FIELD_TYPES,
  type ScoringPolicy,
  type TemplateField,
  type TemplateSection,
} from '@orbit/types';

import { toDisplayString } from './format.js';
import { answerKey, type AnswerMap, evaluateForm } from './logic.js';

export interface ScoredField {
  fieldId: string;
  label: string;
  sectionId: string;
  /** Points awarded, already multiplied by the field weight. */
  earned: number;
  /** Maximum points this field could contribute. */
  possible: number;
  isFailure: boolean;
  isCritical: boolean;
  isNotApplicable: boolean;
  answered: boolean;
}

export interface SectionScore {
  sectionId: string;
  title: string;
  earned: number;
  possible: number;
  percentage: number | null;
  failures: number;
}

export interface ScoreResult {
  /** 0..100, or null when nothing scoreable was answered. */
  percentage: number | null;
  earned: number;
  possible: number;
  outcome: InspectionOutcome;
  totalFields: number;
  answeredFields: number;
  failedFields: number;
  criticalFailures: number;
  notApplicableFields: number;
  sections: SectionScore[];
  fields: ScoredField[];
}

/** Best possible score for a field, used as the denominator contribution. */
function maxScoreFor(field: TemplateField): number {
  if (field.type === FieldType.RATING) {
    return field.ui.ratingMax ?? 5;
  }
  const optionScores = field.options
    .filter((o) => !o.isNotApplicable)
    .map((o) => o.score)
    .filter((s): s is number => typeof s === 'number');
  if (optionScores.length > 0) return Math.max(...optionScores);
  // A scoreable field with no explicit scores is treated as pass/fail worth 1.
  return 1;
}

/** Points earned by a specific answer. */
function earnedScoreFor(
  field: TemplateField,
  value: JsonValue | undefined,
): { earned: number; isFailure: boolean; isNotApplicable: boolean } {
  if (field.type === FieldType.RATING) {
    const n = Number(value);
    return {
      earned: Number.isFinite(n) ? n : 0,
      isFailure: Number.isFinite(n) && n <= (field.ui.ratingMin ?? 1),
      isNotApplicable: false,
    };
  }

  if (field.type === FieldType.NUMBER) {
    // Numeric fields score by whether they sit inside the acceptable band.
    const n = Number(value);
    const { min, max } = field.validation;
    if (!Number.isFinite(n)) return { earned: 0, isFailure: false, isNotApplicable: false };
    const inRange = (min === undefined || n >= min) && (max === undefined || n <= max);
    return { earned: inRange ? 1 : 0, isFailure: !inRange, isNotApplicable: false };
  }

  const selected = Array.isArray(value) ? value.map(toDisplayString) : [toDisplayString(value)];
  const matched = field.options.filter((o) => selected.includes(o.value));

  if (matched.length === 0) {
    return { earned: 0, isFailure: false, isNotApplicable: false };
  }
  if (matched.some((o) => o.isNotApplicable)) {
    return { earned: 0, isFailure: false, isNotApplicable: true };
  }

  const earned = matched.reduce((sum, o) => sum + (o.score ?? 0), 0);
  const isFailure = matched.some((o) => o.isFailure === true || (o.score ?? 0) < 0);
  return { earned: Math.max(0, earned), isFailure, isNotApplicable: false };
}

/**
 * Whether a field contributes to the score at all.
 *
 * Being a scoreable *type* is not enough. Templates are full of yes/no gate
 * questions ("is there a transformer on this site?") that exist to drive
 * conditional logic, not to be marked. Counting those as zero-out-of-one
 * silently halves an otherwise perfect inspection, so a field only scores once
 * its author has actually expressed a scoring intent: a numeric option score, a
 * failure marker, a rating scale, or an acceptable numeric band.
 */
function isScoreable(field: TemplateField): boolean {
  if (!SCOREABLE_FIELD_TYPES.includes(field.type)) return false;

  if (field.type === FieldType.RATING) return true;

  if (field.type === FieldType.NUMBER) {
    // Without a band there is nothing to be right or wrong about.
    return field.validation.min !== undefined || field.validation.max !== undefined;
  }

  return field.options.some((o) => typeof o.score === 'number' || o.isFailure === true);
}

/**
 * Score an inspection.
 *
 * Only visible fields count. A question hidden by conditional logic must not
 * drag the denominator down — an inspector who correctly answered "no
 * transformer on site" should not be penalised for the twelve transformer
 * questions that were consequently never shown.
 */
export function scoreInspection(input: {
  sections: TemplateSection[];
  answers: AnswerMap;
  policy: ScoringPolicy;
  repeatIndex?: number;
}): ScoreResult {
  const { sections, answers, policy, repeatIndex = 0 } = input;
  const evaluation = evaluateForm(sections, answers, repeatIndex);

  const scoredFields: ScoredField[] = [];
  const sectionScores: SectionScore[] = [];

  let totalFields = 0;
  let answeredFields = 0;
  let failedFields = 0;
  let criticalFailures = 0;
  let notApplicableFields = 0;
  let grandEarned = 0;
  let grandPossible = 0;

  const walk = (
    field: TemplateField,
    acc: { earned: number; possible: number; failures: number },
  ): void => {
    const state = evaluation.fields[field.id];
    if (state?.visible) {
      const key = answerKey(field.id, repeatIndex);
      const value = answers[key] ?? answers[field.id];
      const answered = value !== undefined && value !== null && value !== '';

      if (field.type !== FieldType.INSTRUCTION) {
        totalFields += 1;
        if (answered) answeredFields += 1;
      }

      if (isScoreable(field) && answered) {
        const { earned, isFailure, isNotApplicable } = earnedScoreFor(field, value);
        const weight = field.weight > 0 ? field.weight : 1;
        const possible = maxScoreFor(field) * weight;
        const weightedEarned = earned * weight;

        if (isNotApplicable) {
          notApplicableFields += 1;
        }

        // N/A answers leave the denominator when the policy says so; otherwise
        // they score zero out of full marks.
        const countsTowardTotal = !(isNotApplicable && policy.excludeNotApplicable);

        if (countsTowardTotal) {
          acc.earned += weightedEarned;
          acc.possible += possible;
          grandEarned += weightedEarned;
          grandPossible += possible;
        }

        if (isFailure) {
          failedFields += 1;
          acc.failures += 1;
          if (field.isCritical) criticalFailures += 1;
        }

        scoredFields.push({
          fieldId: field.id,
          label: field.label,
          sectionId: field.sectionId,
          earned: countsTowardTotal ? weightedEarned : 0,
          possible: countsTowardTotal ? possible : 0,
          isFailure,
          isCritical: field.isCritical,
          isNotApplicable,
          answered,
        });
      }
    }

    for (const child of field.followUps) walk(child, acc);
  };

  for (const section of sections) {
    if (!evaluation.sections[section.id]?.visible) continue;
    const acc = { earned: 0, possible: 0, failures: 0 };
    for (const field of section.fields) walk(field, acc);

    sectionScores.push({
      sectionId: section.id,
      title: section.title,
      earned: acc.earned,
      possible: acc.possible,
      percentage: acc.possible > 0 ? round2((acc.earned / acc.possible) * 100) : null,
      failures: acc.failures,
    });
  }

  const percentage = grandPossible > 0 ? round2((grandEarned / grandPossible) * 100) : null;

  return {
    percentage,
    earned: round2(grandEarned),
    possible: round2(grandPossible),
    outcome: deriveOutcome(percentage, criticalFailures, failedFields, policy),
    totalFields,
    answeredFields,
    failedFields,
    criticalFailures,
    notApplicableFields,
    sections: sectionScores,
    fields: scoredFields,
  };
}

/** Turn a percentage plus failure counts into a verdict. */
export function deriveOutcome(
  percentage: number | null,
  criticalFailures: number,
  failedFields: number,
  policy: ScoringPolicy,
): InspectionOutcome {
  if (policy.criticalFailureForcesFail && criticalFailures > 0) {
    return InspectionOutcome.FAIL;
  }
  if (!policy.enabled) {
    // Unscored templates still express a verdict via failure-marked options.
    if (failedFields > 0) return InspectionOutcome.FAIL;
    return InspectionOutcome.PASS;
  }
  if (percentage === null) return InspectionOutcome.PENDING;
  if (percentage >= policy.passThreshold) {
    return failedFields > 0 ? InspectionOutcome.PASS_WITH_OBSERVATIONS : InspectionOutcome.PASS;
  }
  if (percentage >= policy.observationThreshold) {
    return InspectionOutcome.PASS_WITH_OBSERVATIONS;
  }
  return InspectionOutcome.FAIL;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const DEFAULT_SCORING_POLICY: ScoringPolicy = {
  enabled: true,
  passThreshold: 80,
  observationThreshold: 60,
  criticalFailureForcesFail: true,
  excludeNotApplicable: true,
};
