/**
 * Checklist template model.
 *
 * Templates are immutable once published: editing produces a new
 * `TemplateVersion`. An in-flight inspection keeps a hard reference to the
 * version it started on, so a template change made in head office at noon can
 * never mutate the questions under an inspector who is mid-inspection in a
 * basement with no signal.
 */

import type { FieldType, Priority } from './enums.js';
import type {
  FieldId,
  IsoTimestamp,
  JsonValue,
  Money,
  OrgId,
  SectionId,
  TemplateId,
  TemplateVersionId,
  UserId,
} from './primitives.js';

/** One selectable option on a choice field. */
export interface FieldOption {
  /** Stable across template versions; responses store this, never the label. */
  value: string;
  label: string;
  /** Optional colour hint for the mobile renderer, `#RRGGBB`. */
  color?: string;
  /**
   * Score contribution when selected. Negative values mark a failure condition.
   * `null` means the option is unscored (informational).
   */
  score?: number | null;
  /** Selecting this option marks the whole inspection as failed. */
  isFailure?: boolean;
  /** Selecting this option excludes the field from scoring entirely. */
  isNotApplicable?: boolean;
}

export type ComparisonOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'IN'
  | 'NOT_IN'
  | 'IS_EMPTY'
  | 'IS_NOT_EMPTY'
  | 'MATCHES_REGEX';

/** A single predicate against another field's answer. */
export interface Condition {
  fieldId: FieldId;
  operator: ComparisonOperator;
  /** Absent for IS_EMPTY / IS_NOT_EMPTY. */
  value?: JsonValue;
}

/**
 * Boolean expression tree. Groups nest arbitrarily deep, so a template author can
 * express "show this section when (voltage > 400 AND phase IN [R,Y,B]) OR
 * emergency = yes" without writing code.
 */
export type ConditionNode =
  | { kind: 'CONDITION'; condition: Condition }
  | { kind: 'ALL'; children: ConditionNode[] }
  | { kind: 'ANY'; children: ConditionNode[] }
  | { kind: 'NONE'; children: ConditionNode[] };

/** What happens when a rule's expression evaluates true. */
export type LogicEffect =
  | { type: 'SHOW' }
  | { type: 'HIDE' }
  | { type: 'REQUIRE' }
  | { type: 'OPTIONAL' }
  | { type: 'DISABLE' }
  /** Force a value into a field — used for computed/derived answers. */
  | { type: 'SET_VALUE'; value: JsonValue }
  /** Raise a non-blocking warning banner on the field. */
  | { type: 'WARN'; message: string }
  /** Block submission with an error until the condition no longer holds. */
  | { type: 'BLOCK_SUBMIT'; message: string }
  /** Reveal a follow-up question group nested under this field. */
  | { type: 'REVEAL_FOLLOW_UPS' };

export interface LogicRule {
  id: string;
  /** Evaluated top-to-bottom; later rules win on conflicting effects. */
  when: ConditionNode;
  effect: LogicEffect;
}

/** Declarative constraints checked identically on device and on the server. */
export interface ValidationRules {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Numeric step for NUMBER/CURRENCY, e.g. 0.5. */
  step?: number;
  /** Decimal places accepted. */
  precision?: number;
  pattern?: string;
  patternMessage?: string;
  /** Earliest/latest acceptable value for DATE/TIME/DATETIME, ISO-8601. */
  minDate?: string;
  maxDate?: string;
  /** Bounds on selection count for MULTI_SELECT. */
  minSelections?: number;
  maxSelections?: number;
  /** Bounds on attachment count for media fields. */
  minAttachments?: number;
  maxAttachments?: number;
  /** Per-file ceiling in bytes. */
  maxFileSizeBytes?: number;
  allowedMimeTypes?: string[];
  /** Photos must carry a GPS fix at least this accurate, in metres. */
  requiredGpsAccuracyMeters?: number;
  /** Reject photos not taken within this many seconds of being attached. */
  maxPhotoAgeSeconds?: number;
}

/** Renderer hints that do not affect validity. */
export interface FieldUiConfig {
  placeholder?: string;
  helpText?: string;
  /** Render choice fields as segmented control / chips / list. */
  variant?: 'DEFAULT' | 'SEGMENTED' | 'CHIPS' | 'LIST' | 'GRID';
  columns?: number;
  /** Show the field full-bleed on tablets. */
  fullWidth?: boolean;
  /** Rating scale bounds, e.g. 1..5 stars. */
  ratingMin?: number;
  ratingMax?: number;
  ratingIcon?: 'STAR' | 'CIRCLE' | 'NUMBER';
  /** Camera constraints for PHOTO fields. */
  camera?: {
    allowGallery: boolean;
    /** Force before/after capture pairs. */
    pairMode?: 'NONE' | 'BEFORE_AFTER';
    watermark: boolean;
    annotationEnabled: boolean;
  };
  currency?: Money['currency'];
}

export interface TemplateField {
  id: FieldId;
  sectionId: SectionId;
  /** Stable machine key used in exports and integrations, e.g. `earth_resistance`. */
  key: string;
  label: string;
  type: FieldType;
  order: number;
  options: FieldOption[];
  validation: ValidationRules;
  ui: FieldUiConfig;
  logic: LogicRule[];
  /**
   * Follow-up questions revealed by this field, e.g. a FAIL answer revealing
   * "describe the defect" + "attach photo". Nested arbitrarily deep.
   */
  followUps: TemplateField[];
  /** Weight applied to this field's score when computing section/total scores. */
  weight: number;
  /** A failure here fails the entire inspection regardless of other scores. */
  isCritical: boolean;
  /** Default answer applied when the inspection is instantiated. */
  defaultValue: JsonValue | null;
  /** Copy the previous inspection's answer for the same asset, when available. */
  carryForward: boolean;
}

export interface TemplateSection {
  id: SectionId;
  templateVersionId: TemplateVersionId;
  title: string;
  description: string | null;
  order: number;
  fields: TemplateField[];
  logic: LogicRule[];
  /** Section can be repeated N times, e.g. one block per distribution panel. */
  repeatable: boolean;
  repeatMinInstances: number;
  repeatMaxInstances: number | null;
  /** Label pattern for repeated instances, e.g. `Panel {{index}}`. */
  repeatLabelTemplate: string | null;
}

/** Thresholds that turn a numeric score into a verdict. */
export interface ScoringPolicy {
  enabled: boolean;
  /** Percentage at or above which the inspection passes. */
  passThreshold: number;
  /** Below `passThreshold` but at or above this → PASS_WITH_OBSERVATIONS. */
  observationThreshold: number;
  /** Any critical-field failure forces FAIL regardless of percentage. */
  criticalFailureForcesFail: boolean;
  /** N/A answers are removed from the denominator rather than scored zero. */
  excludeNotApplicable: boolean;
}

export interface TemplateVersion {
  id: TemplateVersionId;
  templateId: TemplateId;
  /** Monotonic, starts at 1. */
  version: number;
  sections: TemplateSection[];
  scoring: ScoringPolicy;
  /** Signature roles that must be collected before submission. */
  requiredSignatures: string[];
  /** Draft versions are editable and invisible to inspectors. */
  publishedAt: IsoTimestamp | null;
  publishedBy: UserId | null;
  /** Set when superseded; existing inspections continue on this version. */
  retiredAt: IsoTimestamp | null;
  changeNote: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Template {
  id: TemplateId;
  orgId: OrgId;
  name: string;
  description: string | null;
  category: string | null;
  /** e.g. `ELECTRICAL`, `FIRE_SAFETY` — drives dashboard grouping. */
  discipline: string | null;
  defaultPriority: Priority;
  /** Version currently handed to inspectors. Null while only drafts exist. */
  activeVersionId: TemplateVersionId | null;
  isArchived: boolean;
  createdBy: UserId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Template plus its resolved active version — the payload mobile caches. */
export interface TemplateBundle {
  template: Template;
  version: TemplateVersion;
}
