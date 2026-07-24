/**
 * Template repository.
 *
 * Templates are read-only on the device — they are authored in the admin
 * dashboard and replicated down. The definition arrives as one JSON document
 * and is parsed here into the typed section tree the form renderer consumes.
 *
 * Parsing is cached: a 200-question template is a large object graph, and
 * re-parsing it on every render of the inspection form is the single easiest
 * way to make the app feel slow.
 */

import type { ScoringPolicy, TemplateSection, TemplateVersion } from '@orbit/types';
import { DEFAULT_SCORING_POLICY } from '@orbit/utils';
import type { Database } from '../database';

interface TemplateVersionRow {
  id: string;
  org_id: string;
  template_id: string;
  name: string;
  description: string | null;
  category: string | null;
  discipline: string | null;
  version: number;
  definition: string;
  scoring: string;
  required_signatures: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TemplateSummary {
  id: string;
  templateId: string;
  name: string;
  description: string | null;
  category: string | null;
  discipline: string | null;
  version: number;
  sectionCount: number;
  fieldCount: number;
}

export interface ParsedTemplate {
  id: string;
  templateId: string;
  name: string;
  description: string | null;
  category: string | null;
  discipline: string | null;
  version: number;
  sections: TemplateSection[];
  scoring: ScoringPolicy;
  requiredSignatures: string[];
}

export class TemplateRepository {
  /**
   * Parsed-template cache, keyed by template version id.
   *
   * Safe to cache indefinitely because a published template version is
   * immutable by design — an edit creates a new version with a new id, so a
   * cached entry can never go stale.
   */
  private readonly cache = new Map<string, ParsedTemplate>();

  constructor(private readonly db: Database) {}

  private parse(row: TemplateVersionRow): ParsedTemplate {
    const cached = this.cache.get(row.id);
    if (cached) return cached;

    let sections: TemplateSection[] = [];
    try {
      const definition = JSON.parse(row.definition) as { sections?: TemplateSection[] } | TemplateSection[];
      // Accept both the wrapped and bare shapes — early template exports used
      // a bare array, and rejecting those would strand existing inspections.
      sections = Array.isArray(definition) ? definition : (definition.sections ?? []);
    } catch {
      // A template that will not parse cannot be rendered. Returning an empty
      // section list makes that visible as "no questions" rather than crashing
      // the form and losing the inspector's place.
      sections = [];
    }

    let scoring: ScoringPolicy = DEFAULT_SCORING_POLICY;
    try {
      const parsed = JSON.parse(row.scoring) as Partial<ScoringPolicy>;
      scoring = { ...DEFAULT_SCORING_POLICY, ...parsed };
    } catch {
      scoring = DEFAULT_SCORING_POLICY;
    }

    let requiredSignatures: string[] = [];
    try {
      requiredSignatures = JSON.parse(row.required_signatures) as string[];
    } catch {
      requiredSignatures = [];
    }

    const parsed: ParsedTemplate = {
      id: row.id,
      templateId: row.template_id,
      name: row.name,
      description: row.description,
      category: row.category,
      discipline: row.discipline,
      version: row.version,
      sections,
      scoring,
      requiredSignatures,
    };

    this.cache.set(row.id, parsed);
    return parsed;
  }

  /** Load a specific version — what an in-progress inspection is pinned to. */
  findVersion(templateVersionId: string): ParsedTemplate | null {
    const row = this.db.getFirst<TemplateVersionRow>(
      `SELECT * FROM template_versions WHERE id = ? AND deleted_at IS NULL`,
      [templateVersionId],
    );
    return row ? this.parse(row) : null;
  }

  /** Latest published version of a template, for starting new work. */
  findLatestForTemplate(templateId: string): ParsedTemplate | null {
    const row = this.db.getFirst<TemplateVersionRow>(
      `SELECT * FROM template_versions
        WHERE template_id = ? AND deleted_at IS NULL AND published_at IS NOT NULL
        ORDER BY version DESC LIMIT 1`,
      [templateId],
    );
    return row ? this.parse(row) : null;
  }

  /**
   * Templates available to start.
   *
   * Only published versions, and only the newest of each template — offering an
   * inspector a superseded version is how inconsistent data gets collected.
   */
  listAvailable(search?: string): TemplateSummary[] {
    const rows = this.db.getAll<TemplateVersionRow>(
      `SELECT tv.* FROM template_versions tv
        JOIN (
          SELECT template_id, MAX(version) AS max_version
            FROM template_versions
           WHERE deleted_at IS NULL AND published_at IS NOT NULL
           GROUP BY template_id
        ) latest
          ON latest.template_id = tv.template_id AND latest.max_version = tv.version
       WHERE tv.deleted_at IS NULL AND tv.published_at IS NOT NULL
         ${search ? 'AND (tv.name LIKE ? OR tv.category LIKE ? OR tv.discipline LIKE ?)' : ''}
       ORDER BY tv.name ASC`,
      search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [],
    );

    return rows.map((row) => {
      const parsed = this.parse(row);
      const fieldCount = parsed.sections.reduce((sum, section) => {
        const countFields = (fields: TemplateSection['fields']): number =>
          fields.reduce((n, f) => n + 1 + countFields(f.followUps), 0);
        return sum + countFields(section.fields);
      }, 0);

      return {
        id: parsed.id,
        templateId: parsed.templateId,
        name: parsed.name,
        description: parsed.description,
        category: parsed.category,
        discipline: parsed.discipline,
        version: parsed.version,
        sectionCount: parsed.sections.length,
        fieldCount,
      };
    });
  }

  /** Distinct categories, for the template picker's filter chips. */
  categories(): string[] {
    return this.db
      .getAll<{ category: string }>(
        `SELECT DISTINCT category FROM template_versions
          WHERE category IS NOT NULL AND deleted_at IS NULL AND published_at IS NOT NULL
          ORDER BY category ASC`,
      )
      .map((r) => r.category);
  }

  count(): number {
    const row = this.db.getFirst<{ n: number }>(
      `SELECT COUNT(DISTINCT template_id) AS n FROM template_versions
        WHERE deleted_at IS NULL AND published_at IS NOT NULL`,
    );
    return row?.n ?? 0;
  }

  /** Drop the parse cache — called after a full resync replaces templates. */
  clearCache(): void {
    this.cache.clear();
  }
}

export type { TemplateVersion };
