/**
 * Response validation.
 *
 * Runs on every keystroke on the device and again on the server at submission.
 * The device copy gives instant feedback; the server copy is the one that
 * actually protects the data, because a device is an untrusted client.
 */

import {
  FieldType,
  MEDIA_FIELD_TYPES,
  type Attachment,
  type GeoPoint,
  type JsonValue,
  type TemplateField,
  type TemplateSection,
  type ValidationRules,
} from '@orbit/types';
import { answerKey, evaluateForm, flattenFields, type AnswerMap } from './logic.js';

export interface ValidationIssue {
  fieldId: string;
  fieldLabel: string;
  sectionId: string;
  repeatIndex: number;
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING';
}

export interface ValidationOutcome {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function isBlank(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function countDecimals(n: number): number {
  if (Number.isInteger(n)) return 0;
  const s = String(n);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.split('.')[1]?.length ?? 0;
}

/**
 * Validate one answer against one field's rules.
 * Returns issue codes rather than only messages so the mobile UI can localise.
 */
export function validateValue(
  field: TemplateField,
  value: JsonValue | undefined,
  ctx: {
    attachments?: Attachment[];
    /** Used to check photo freshness. Injected so the function stays pure. */
    now?: number;
  } = {},
): Array<{ code: string; message: string; severity: 'ERROR' | 'WARNING' }> {
  const issues: Array<{ code: string; message: string; severity: 'ERROR' | 'WARNING' }> = [];
  const rules: ValidationRules = field.validation;
  const push = (code: string, message: string, severity: 'ERROR' | 'WARNING' = 'ERROR') =>
    issues.push({ code, message, severity });

  const isMedia = MEDIA_FIELD_TYPES.includes(field.type);
  const attachments = ctx.attachments ?? [];

  // INSTRUCTION blocks never hold an answer.
  if (field.type === FieldType.INSTRUCTION) return issues;

  // ---- presence -----------------------------------------------------------
  if (isMedia) {
    const min = rules.minAttachments ?? (rules.required ? 1 : 0);
    if (attachments.length < min) {
      push(
        'ATTACHMENT_REQUIRED',
        min === 1
          ? `${field.label} requires an attachment.`
          : `${field.label} requires at least ${min} attachments.`,
      );
    }
    if (rules.maxAttachments !== undefined && attachments.length > rules.maxAttachments) {
      push('ATTACHMENT_TOO_MANY', `${field.label} allows at most ${rules.maxAttachments} attachments.`);
    }
    for (const a of attachments) {
      if (rules.maxFileSizeBytes !== undefined && a.sizeBytes > rules.maxFileSizeBytes) {
        push('FILE_TOO_LARGE', `"${a.fileName}" exceeds the ${Math.round(rules.maxFileSizeBytes / 1_048_576)} MB limit.`);
      }
      if (rules.allowedMimeTypes?.length && !rules.allowedMimeTypes.includes(a.mimeType)) {
        push('FILE_TYPE_NOT_ALLOWED', `"${a.fileName}" is not an accepted file type.`);
      }
      if (rules.requiredGpsAccuracyMeters !== undefined) {
        const acc = a.location?.accuracy;
        if (acc === null || acc === undefined) {
          push('PHOTO_GPS_MISSING', `"${a.fileName}" has no location fix.`);
        } else if (acc > rules.requiredGpsAccuracyMeters) {
          push(
            'PHOTO_GPS_INACCURATE',
            `"${a.fileName}" was captured with ±${Math.round(acc)} m accuracy; ±${rules.requiredGpsAccuracyMeters} m or better is required.`,
            'WARNING',
          );
        }
      }
      if (rules.maxPhotoAgeSeconds !== undefined && a.capturedAt) {
        const ageSeconds = ((ctx.now ?? Date.now()) - Date.parse(a.capturedAt)) / 1000;
        if (ageSeconds > rules.maxPhotoAgeSeconds) {
          push('PHOTO_STALE', `"${a.fileName}" was not captured during this inspection.`);
        }
      }
    }
    return issues;
  }

  if (isBlank(value)) {
    if (rules.required) push('REQUIRED', `${field.label} is required.`);
    return issues; // no point validating the shape of an absent value
  }

  // ---- per-type shape and range ------------------------------------------
  switch (field.type) {
    case FieldType.TEXT:
    case FieldType.TEXT_AREA:
    case FieldType.BARCODE: {
      if (typeof value !== 'string') {
        push('TYPE_MISMATCH', `${field.label} must be text.`);
        break;
      }
      const len = value.trim().length;
      if (rules.minLength !== undefined && len < rules.minLength) {
        push('TOO_SHORT', `${field.label} must be at least ${rules.minLength} characters.`);
      }
      if (rules.maxLength !== undefined && len > rules.maxLength) {
        push('TOO_LONG', `${field.label} must be at most ${rules.maxLength} characters.`);
      }
      if (rules.pattern) {
        try {
          if (!new RegExp(rules.pattern).test(value)) {
            push('PATTERN', rules.patternMessage ?? `${field.label} is not in the expected format.`);
          }
        } catch {
          push('PATTERN_INVALID', `${field.label} has a misconfigured validation pattern.`, 'WARNING');
        }
      }
      break;
    }

    case FieldType.NUMBER:
    case FieldType.CURRENCY:
    case FieldType.RATING: {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        push('TYPE_MISMATCH', `${field.label} must be a number.`);
        break;
      }
      if (rules.min !== undefined && n < rules.min) {
        push('BELOW_MIN', `${field.label} must be at least ${rules.min}.`);
      }
      if (rules.max !== undefined && n > rules.max) {
        push('ABOVE_MAX', `${field.label} must be at most ${rules.max}.`);
      }
      if (rules.precision !== undefined && countDecimals(n) > rules.precision) {
        push('PRECISION', `${field.label} allows at most ${rules.precision} decimal places.`);
      }
      if (rules.step !== undefined && rules.step > 0) {
        const base = rules.min ?? 0;
        // Float modulo is unreliable; scale to integers before testing.
        const scale = Math.pow(10, Math.max(countDecimals(rules.step), countDecimals(n)));
        const offset = Math.round((n - base) * scale);
        const step = Math.round(rules.step * scale);
        if (step > 0 && offset % step !== 0) {
          push('STEP', `${field.label} must be in increments of ${rules.step}.`);
        }
      }
      if (field.type === FieldType.RATING) {
        const lo = field.ui.ratingMin ?? 1;
        const hi = field.ui.ratingMax ?? 5;
        if (n < lo || n > hi) {
          push('RATING_RANGE', `${field.label} must be between ${lo} and ${hi}.`);
        }
      }
      break;
    }

    case FieldType.CHECKBOX:
    case FieldType.YES_NO:
    case FieldType.PASS_FAIL: {
      // Stored as the option value string, or a boolean for plain checkboxes.
      if (field.options.length > 0) {
        const valid = field.options.some((o) => o.value === value);
        if (!valid) push('INVALID_OPTION', `${field.label} has an unrecognised answer.`);
      } else if (typeof value !== 'boolean') {
        push('TYPE_MISMATCH', `${field.label} must be yes or no.`);
      }
      break;
    }

    case FieldType.RADIO:
    case FieldType.DROPDOWN: {
      if (typeof value !== 'string' || !field.options.some((o) => o.value === value)) {
        push('INVALID_OPTION', `${field.label} has an unrecognised answer.`);
      }
      break;
    }

    case FieldType.MULTI_SELECT: {
      if (!Array.isArray(value)) {
        push('TYPE_MISMATCH', `${field.label} must be a list of selections.`);
        break;
      }
      const unknown = value.filter((v) => !field.options.some((o) => o.value === v));
      if (unknown.length > 0) {
        push('INVALID_OPTION', `${field.label} contains unrecognised selections.`);
      }
      if (new Set(value.map(String)).size !== value.length) {
        push('DUPLICATE_SELECTION', `${field.label} contains duplicate selections.`);
      }
      if (rules.minSelections !== undefined && value.length < rules.minSelections) {
        push('TOO_FEW_SELECTED', `Select at least ${rules.minSelections} options for ${field.label}.`);
      }
      if (rules.maxSelections !== undefined && value.length > rules.maxSelections) {
        push('TOO_MANY_SELECTED', `Select at most ${rules.maxSelections} options for ${field.label}.`);
      }
      break;
    }

    case FieldType.DATE:
    case FieldType.DATETIME: {
      const s = String(value);
      const parsed = Date.parse(s);
      const shapeOk = field.type === FieldType.DATE ? ISO_DATE.test(s) : !Number.isNaN(parsed);
      if (!shapeOk || Number.isNaN(parsed)) {
        push('INVALID_DATE', `${field.label} is not a valid date.`);
        break;
      }
      if (rules.minDate && parsed < Date.parse(rules.minDate)) {
        push('DATE_TOO_EARLY', `${field.label} must be on or after ${rules.minDate}.`);
      }
      if (rules.maxDate && parsed > Date.parse(rules.maxDate)) {
        push('DATE_TOO_LATE', `${field.label} must be on or before ${rules.maxDate}.`);
      }
      break;
    }

    case FieldType.TIME: {
      if (typeof value !== 'string' || !ISO_TIME.test(value)) {
        push('INVALID_TIME', `${field.label} is not a valid time.`);
      }
      break;
    }

    case FieldType.GPS: {
      const p = value as unknown as GeoPoint | null;
      if (!p || typeof p !== 'object' || typeof p.latitude !== 'number' || typeof p.longitude !== 'number') {
        push('INVALID_LOCATION', `${field.label} requires a location fix.`);
        break;
      }
      if (p.latitude < -90 || p.latitude > 90 || p.longitude < -180 || p.longitude > 180) {
        push('LOCATION_OUT_OF_RANGE', `${field.label} has coordinates outside the valid range.`);
      }
      if (rules.requiredGpsAccuracyMeters !== undefined) {
        if (p.accuracy === null) {
          push('LOCATION_ACCURACY_UNKNOWN', `${field.label} has no accuracy reading.`, 'WARNING');
        } else if (p.accuracy > rules.requiredGpsAccuracyMeters) {
          push(
            'LOCATION_INACCURATE',
            `${field.label} needs a fix accurate to ±${rules.requiredGpsAccuracyMeters} m (currently ±${Math.round(p.accuracy)} m).`,
            'WARNING',
          );
        }
      }
      if (p.mocked) {
        push('LOCATION_MOCKED', `${field.label} reported a simulated location.`);
      }
      break;
    }

    default:
      break;
  }

  return issues;
}

/**
 * Validate a whole inspection. Hidden fields are skipped entirely — the logic
 * evaluator decides visibility first, so an inspector is never blocked by a
 * question that was never on screen.
 */
export function validateInspection(input: {
  sections: TemplateSection[];
  answers: AnswerMap;
  attachmentsByField?: Record<string, Attachment[]>;
  repeatIndex?: number;
  now?: number;
}): ValidationOutcome {
  const { sections, answers, attachmentsByField = {}, repeatIndex = 0 } = input;
  const evaluation = evaluateForm(sections, answers, repeatIndex);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const field of flattenFields(sections)) {
    const state = evaluation.fields[field.id];
    if (!state?.visible) continue;

    const key = answerKey(field.id, repeatIndex);
    const value = answers[key] ?? answers[field.id];

    // The evaluator's REQUIRE/OPTIONAL effects override the static rule, so
    // validate against the resolved state rather than the template.
    const effective: TemplateField = state.required === field.validation.required
      ? field
      : { ...field, validation: { ...field.validation, required: state.required } };

    const issues = validateValue(effective, value, {
      attachments: attachmentsByField[field.id] ?? [],
      now: input.now,
    });

    for (const issue of issues) {
      const record: ValidationIssue = {
        fieldId: field.id,
        fieldLabel: field.label,
        sectionId: field.sectionId,
        repeatIndex,
        code: issue.code,
        message: issue.message,
        severity: issue.severity,
      };
      (issue.severity === 'ERROR' ? errors : warnings).push(record);
    }

    for (const warning of state.warnings) {
      warnings.push({
        fieldId: field.id,
        fieldLabel: field.label,
        sectionId: field.sectionId,
        repeatIndex,
        code: 'LOGIC_WARNING',
        message: warning,
        severity: 'WARNING',
      });
    }
  }

  for (const blocker of evaluation.blockers) {
    errors.push({
      fieldId: '',
      fieldLabel: '',
      sectionId: '',
      repeatIndex,
      code: 'LOGIC_BLOCK',
      message: blocker,
      severity: 'ERROR',
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}
