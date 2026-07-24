/**
 * Inspection form state.
 *
 * Binds the three existing engines to a live SQLite-backed form:
 *   `evaluateForm`      → which questions are visible, required, blocking
 *   `validateInspection`→ what is wrong, per field
 *   `scoreInspection`   → running score and outcome
 *
 * None of that logic is reimplemented here. This hook only orchestrates: read
 * answers, run the engines, write answers back through the repository.
 *
 * Auto-save policy is the interesting decision. Every answer is written to
 * SQLite **immediately and synchronously** — an inspector who drops their phone
 * off a gantry mid-question must lose nothing. What is debounced is only the
 * expensive derived work (re-scoring, updating the inspection's cached
 * counters), because recomputing a 200-question score on every keystroke of a
 * text field makes the form feel broken.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FieldType,
  MEDIA_FIELD_TYPES,
  type Attachment,
  type InspectionOutcome,
  type JsonValue,
  type TemplateField,
  type TemplateSection,
} from '@orbit/types';
import {
  answerKey,
  evaluateForm,
  flattenFields,
  scoreInspection,
  validateInspection,
  validateValue,
  type AnswerMap,
  type EvaluationResult,
  type ScoreResult,
  type ValidationIssue,
} from '@orbit/utils';
import type { Runtime } from '../../runtime/runtime';
import type { ParsedTemplate } from '../../db/repositories/template.repository';
import { invalidateQueries } from '../../hooks/useLiveQuery';

/** How long after the last edit derived state is recomputed. */
const RECOMPUTE_DEBOUNCE_MS = 400;

export interface FormFieldState {
  field: TemplateField;
  visible: boolean;
  required: boolean;
  disabled: boolean;
  value: JsonValue;
  attachments: Attachment[];
  /** Errors shown only after the field has been touched or a submit attempted. */
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  touched: boolean;
}

export interface FormSectionState {
  section: TemplateSection;
  visible: boolean;
  fields: FormFieldState[];
  answeredCount: number;
  requiredCount: number;
  errorCount: number;
  /** True when every visible required question in the section is answered. */
  complete: boolean;
}

export interface InspectionFormState {
  template: ParsedTemplate | null;
  sections: FormSectionState[];
  answers: AnswerMap;
  evaluation: EvaluationResult | null;
  score: ScoreResult | null;
  /** 0..1 across visible questions. */
  progress: number;
  answeredCount: number;
  totalCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Blocking messages from BLOCK_SUBMIT logic rules. */
  blockers: string[];
  canSubmit: boolean;
  loading: boolean;
  /** Set while the derived recompute is pending — drives the "Saving…" chip. */
  saving: boolean;
  lastSavedAt: string | null;
}

export interface InspectionFormApi extends InspectionFormState {
  setValue: (field: TemplateField, value: JsonValue, options?: { repeatIndex?: number }) => void;
  setComment: (field: TemplateField, comment: string, options?: { repeatIndex?: number }) => void;
  markTouched: (fieldId: string) => void;
  /** Reveal every error at once, e.g. when submit is pressed. */
  revealAllErrors: () => void;
  refresh: () => void;
  /** Field ids with errors, in document order — drives "jump to first problem". */
  errorFieldIds: string[];
}

export function useInspectionForm(input: {
  runtime: Runtime;
  inspectionId: string;
  repeatIndex?: number;
}): InspectionFormApi {
  const { runtime, inspectionId, repeatIndex = 0 } = input;

  const [template, setTemplate] = useState<ParsedTemplate | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [attachmentsByField, setAttachmentsByField] = useState<Record<string, Attachment[]>>({});
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const recomputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- load ---------------------------------------------------------------

  const load = useCallback(() => {
    const inspection = runtime.repositories.inspections.findById(inspectionId);
    if (!inspection) {
      setLoading(false);
      return;
    }

    const parsed = runtime.repositories.templates.findVersion(inspection.templateVersionId);
    setTemplate(parsed);
    setAnswers(runtime.repositories.responses.answerMap(inspectionId));
    setAttachmentsByField(runtime.repositories.attachments.byFieldForInspection(inspectionId));
    setLoading(false);
  }, [runtime, inspectionId]);

  useEffect(() => {
    load();
  }, [load, revision]);

  const refresh = useCallback(() => setRevision((r) => r + 1), []);

  // --- derived state ------------------------------------------------------

  const evaluation = useMemo<EvaluationResult | null>(() => {
    if (!template) return null;
    return evaluateForm(template.sections, answers, repeatIndex);
  }, [template, answers, repeatIndex]);

  const validation = useMemo(() => {
    if (!template) return { valid: true, errors: [], warnings: [] };
    return validateInspection({
      sections: template.sections,
      answers,
      attachmentsByField,
      repeatIndex,
    });
  }, [template, answers, attachmentsByField, repeatIndex]);

  const score = useMemo<ScoreResult | null>(() => {
    if (!template) return null;
    return scoreInspection({
      sections: template.sections,
      answers,
      policy: template.scoring,
      repeatIndex,
    });
  }, [template, answers, repeatIndex]);

  /** Per-field errors, keyed for O(1) lookup while rendering. */
  const issuesByField = useMemo(() => {
    const map: Record<string, { errors: ValidationIssue[]; warnings: ValidationIssue[] }> = {};
    for (const issue of validation.errors) {
      (map[issue.fieldId] ??= { errors: [], warnings: [] }).errors.push(issue);
    }
    for (const issue of validation.warnings) {
      (map[issue.fieldId] ??= { errors: [], warnings: [] }).warnings.push(issue);
    }
    return map;
  }, [validation]);

  const sections = useMemo<FormSectionState[]>(() => {
    if (!template || !evaluation) return [];

    const build = (field: TemplateField): FormFieldState[] => {
      const state = evaluation.fields[field.id];
      const key = answerKey(field.id, repeatIndex);
      const issues = issuesByField[field.id] ?? { errors: [], warnings: [] };
      const isTouched = touched.has(field.id) || showAllErrors;

      const self: FormFieldState = {
        field,
        visible: state?.visible ?? true,
        required: state?.required ?? false,
        disabled: state?.disabled ?? false,
        // A SET_VALUE logic effect overrides whatever is stored.
        value: state?.forcedValue !== undefined ? state.forcedValue : (answers[key] ?? answers[field.id] ?? null),
        attachments: attachmentsByField[field.id] ?? [],
        // Errors stay hidden until the user has engaged with the field —
        // showing "required" on every blank question the moment the form opens
        // is noise that trains people to ignore it.
        errors: isTouched ? issues.errors : [],
        warnings: isTouched ? issues.warnings : [],
        touched: isTouched,
      };

      // Follow-ups are rendered inline beneath their parent, so they are
      // flattened into the same list in document order.
      return [self, ...field.followUps.flatMap(build)];
    };

    return template.sections.map((section) => {
      const fields = section.fields.flatMap(build);
      const visibleFields = fields.filter((f) => f.visible && f.field.type !== FieldType.INSTRUCTION);
      const required = visibleFields.filter((f) => f.required);

      const isAnswered = (f: FormFieldState): boolean =>
        MEDIA_FIELD_TYPES.includes(f.field.type)
          ? f.attachments.length > 0
          : f.value !== null && f.value !== undefined && f.value !== '' &&
            !(Array.isArray(f.value) && f.value.length === 0);

      const answered = visibleFields.filter(isAnswered).length;
      const errorCount = fields.reduce((n, f) => n + (issuesByField[f.field.id]?.errors.length ?? 0), 0);

      return {
        section,
        visible: evaluation.sections[section.id]?.visible ?? true,
        fields,
        answeredCount: answered,
        requiredCount: required.length,
        errorCount,
        complete: required.every(isAnswered),
      };
    });
  }, [template, evaluation, answers, attachmentsByField, issuesByField, touched, showAllErrors, repeatIndex]);

  const { answeredCount, totalCount } = useMemo(() => {
    let answered = 0;
    let total = 0;
    for (const section of sections) {
      if (!section.visible) continue;
      for (const fieldState of section.fields) {
        if (!fieldState.visible || fieldState.field.type === FieldType.INSTRUCTION) continue;
        total += 1;
        const hasValue = MEDIA_FIELD_TYPES.includes(fieldState.field.type)
          ? fieldState.attachments.length > 0
          : fieldState.value !== null &&
            fieldState.value !== undefined &&
            fieldState.value !== '' &&
            !(Array.isArray(fieldState.value) && fieldState.value.length === 0);
        if (hasValue) answered += 1;
      }
    }
    return { answeredCount: answered, totalCount: total };
  }, [sections]);

  const errorFieldIds = useMemo(
    () => validation.errors.map((e) => e.fieldId).filter(Boolean),
    [validation.errors],
  );

  // --- writes -------------------------------------------------------------

  /**
   * Persist the derived counters back onto the inspection row.
   *
   * Debounced, and only after the engines have settled. This is the write that
   * makes the list screen's progress bar and score accurate without the form
   * having to push on every keystroke.
   */
  const scheduleRecompute = useCallback(() => {
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    setSaving(true);

    recomputeTimer.current = setTimeout(() => {
      try {
        const current = runtime.repositories.responses.answerMap(inspectionId);
        const parsed = template;
        if (!parsed) return;

        const freshScore = scoreInspection({
          sections: parsed.sections,
          answers: current,
          policy: parsed.scoring,
          repeatIndex,
        });

        runtime.repositories.inspections.refreshProgress(inspectionId, {
          score: freshScore.percentage,
          outcome: freshScore.outcome as InspectionOutcome,
          totalFields: freshScore.totalFields,
          answeredFields: freshScore.answeredFields,
          failedFields: freshScore.failedFields,
          criticalFailures: freshScore.criticalFailures,
        });

        setLastSavedAt(new Date().toISOString());
        invalidateQueries();
      } finally {
        setSaving(false);
      }
    }, RECOMPUTE_DEBOUNCE_MS);
  }, [runtime, inspectionId, template, repeatIndex]);

  useEffect(() => {
    return () => {
      if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    };
  }, []);

  const setValue = useCallback(
    (field: TemplateField, value: JsonValue, options?: { repeatIndex?: number }) => {
      const index = options?.repeatIndex ?? repeatIndex;

      // Per-answer scoring, computed here so the stored row carries the same
      // verdict the scoring engine would derive. Cheap: one field, not the form.
      const singleFieldScore = scoreInspection({
        sections: [
          {
            ...({} as TemplateSection),
            id: field.sectionId,
            templateVersionId: '' as TemplateSection['templateVersionId'],
            title: '',
            description: null,
            order: 0,
            fields: [field],
            logic: [],
            repeatable: false,
            repeatMinInstances: 1,
            repeatMaxInstances: null,
            repeatLabelTemplate: null,
          },
        ],
        answers: { [answerKey(field.id, index)]: value },
        policy: template?.scoring ?? { enabled: false, passThreshold: 0, observationThreshold: 0, criticalFailureForcesFail: false, excludeNotApplicable: true },
        repeatIndex: index,
      });

      const scored = singleFieldScore.fields[0];

      // Written synchronously and durably before React state updates. If the
      // process dies on the next line, the answer is already safe.
      runtime.repositories.responses.upsert({
        inspectionId,
        sectionId: field.sectionId,
        fieldId: field.id,
        repeatIndex: index,
        value,
        score: scored?.earned ?? null,
        isFailure: scored?.isFailure ?? false,
        isNotApplicable: scored?.isNotApplicable ?? false,
      });

      setAnswers((prev) => ({ ...prev, [answerKey(field.id, index)]: value }));
      setTouched((prev) => new Set(prev).add(field.id));
      scheduleRecompute();
    },
    [runtime, inspectionId, repeatIndex, template, scheduleRecompute],
  );

  const setComment = useCallback(
    (field: TemplateField, comment: string, options?: { repeatIndex?: number }) => {
      const index = options?.repeatIndex ?? repeatIndex;
      const key = answerKey(field.id, index);
      runtime.repositories.responses.upsert({
        inspectionId,
        sectionId: field.sectionId,
        fieldId: field.id,
        repeatIndex: index,
        value: answers[key] ?? null,
        comment,
      });
      scheduleRecompute();
    },
    [runtime, inspectionId, repeatIndex, answers, scheduleRecompute],
  );

  const markTouched = useCallback((fieldId: string) => {
    setTouched((prev) => (prev.has(fieldId) ? prev : new Set(prev).add(fieldId)));
  }, []);

  const revealAllErrors = useCallback(() => setShowAllErrors(true), []);

  return {
    template,
    sections,
    answers,
    evaluation,
    score,
    progress: totalCount > 0 ? answeredCount / totalCount : 0,
    answeredCount,
    totalCount,
    errors: validation.errors,
    warnings: validation.warnings,
    blockers: evaluation?.blockers ?? [],
    canSubmit: validation.valid && (evaluation?.blockers.length ?? 0) === 0,
    loading,
    saving,
    lastSavedAt,
    setValue,
    setComment,
    markTouched,
    revealAllErrors,
    refresh,
    errorFieldIds,
  };
}

/** Standalone single-field validation, for inline feedback while typing. */
export function validateSingle(
  field: TemplateField,
  value: JsonValue,
  attachments: Attachment[] = [],
): ValidationIssue[] {
  return validateValue(field, value, { attachments }).map((issue) => ({
    fieldId: field.id,
    fieldLabel: field.label,
    sectionId: field.sectionId,
    repeatIndex: 0,
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
  }));
}

export { flattenFields };
