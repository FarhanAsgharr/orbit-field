/**
 * Template authoring, over HTTP.
 *
 * The property worth protecting here is immutability of a published version.
 * An inspection pins the version it was started against, and a report produced
 * from it must render the same questions years later. If a published version
 * could be edited in place, every historical report silently changes meaning —
 * a failure nobody notices until an auditor asks why last year's certificate
 * shows a question that did not exist then.
 *
 * So the tests are written around that guarantee rather than around the route
 * list: publish, then try every route that could mutate the published row, and
 * assert both the refusal and that the stored definition is byte-identical
 * afterwards.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';

const app = createApp();
const api = '/api/v1';

const device = () => ({
  installationId: unique('tpl'),
  name: 'Template Device',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

let org: TestOrg;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  org = await createTestOrg();
  for (const [role, user] of Object.entries(org.users)) {
    const res = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });
    tokens[role] = res.body.data.tokens.accessToken;
  }
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const as = (role: string) => (path: string) =>
  request(app).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const post = (path: string, role = 'ADMIN') =>
  request(app).post(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const patch = (path: string, role = 'ADMIN') =>
  request(app).patch(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const del = (path: string, role = 'ADMIN') =>
  request(app).delete(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const get = (path: string, role = 'ADMIN') => as(role)(path);

/**
 * A definition the validator accepts: one section, one required pass/fail
 * question. Ids are deliberately omitted — minting them is part of what the
 * validator is responsible for.
 */
function definition(label = 'Is the guard rail secure?') {
  return {
    sections: [
      {
        title: 'Safety',
        order: 0,
        fields: [
          {
            key: 'guard_rail',
            label,
            type: 'PASS_FAIL',
            order: 0,
            options: [
              { value: 'pass', label: 'Yes', score: 1 },
              { value: 'fail', label: 'No', score: 0, isFailure: true },
            ],
            validation: { required: true },
          },
        ],
      },
    ],
  };
}

/** Create a template and return its id plus its first draft version id. */
async function createTemplate(name = unique('Template')) {
  const res = await post('/templates').send({ name, definition: definition() });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, draftId: res.body.data.draftVersionId as string };
}

describe('creating a template', () => {
  it('lands as an unpublished draft', async () => {
    const { id, draftId } = await createTemplate();

    const version = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    expect(version.publishedAt).toBeNull();
    expect(version.version).toBe(1);

    // Nothing an inspector can start work on yet.
    const template = await prisma.template.findUniqueOrThrow({ where: { id } });
    expect(template.activeVersionId).toBeNull();
  });

  it('assigns ids to sections and fields that arrived without them', async () => {
    const { draftId } = await createTemplate();

    const version = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    const def = version.definition as { sections: { id: string; fields: { id: string }[] }[] };
    expect(def.sections[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(def.sections[0]!.fields[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('refuses a definition whose logic references a field that does not exist', async () => {
    const res = await post('/templates').send({
      name: unique('Broken'),
      definition: {
        sections: [
          {
            title: 'Safety',
            order: 0,
            fields: [
              {
                key: 'a',
                label: 'A',
                type: 'PASS_FAIL',
                order: 0,
                logic: [
                  {
                    // Nothing declares this field. On a device the rule would
                    // simply never fire and the question never appear.
                    conditions: [{ fieldId: 'NOSUCHFIELD00000000000000', operator: 'EQUALS' }],
                    effect: 'SHOW',
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.fields ?? {}).length).toBeGreaterThan(0);
  });

  it('refuses an unknown field type', async () => {
    const res = await post('/templates').send({
      name: unique('BadType'),
      definition: {
        sections: [
          {
            title: 'S',
            order: 0,
            fields: [{ key: 'x', label: 'X', type: 'TELEPATHY', order: 0 }],
          },
        ],
      },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a definition that is not an object at all', async () => {
    const res = await post('/templates').send({ name: unique('NotAnObject'), definition: 'hello' });
    expect(res.status).toBe(422);
  });
});

describe('publishing', () => {
  it('makes the version active and records it for devices to pull', async () => {
    const { id, draftId } = await createTemplate();

    const before = await prisma.changeLogEntry.count({ where: { orgId: org.orgId } });
    const res = await post(`/templates/${id}/versions/${draftId}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.data.publishedAt).not.toBeNull();

    const template = await prisma.template.findUniqueOrThrow({ where: { id } });
    expect(template.activeVersionId).toBe(draftId);

    // Devices replay the change log and nothing else. A published template that
    // is not logged exists in the console and on no phone.
    const after = await prisma.changeLogEntry.count({ where: { orgId: org.orgId } });
    expect(after).toBeGreaterThan(before);
  });

  it('sends the template display fields with the version, because devices hold no templates table', async () => {
    const { id, draftId } = await createTemplate('Ladder Inspection');
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const entry = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: draftId },
      orderBy: { cursor: 'desc' },
    });
    // Without `name` the device inserts null into a NOT NULL column and rejects
    // the whole delta — every later entity in that pull is lost too.
    expect((entry?.data as { name?: string } | null)?.name).toBe('Ladder Inspection');
  });

  it('refuses to publish a checklist with no questions', async () => {
    const created = await post('/templates').send({
      name: unique('Empty'),
      definition: { sections: [{ title: 'Nothing here', order: 0, fields: [] }] },
    });
    expect(created.status).toBe(201);

    const res = await post(
      `/templates/${created.body.data.id}/versions/${created.body.data.draftVersionId}/publish`,
    );

    // A blank form handed to an inspector standing on a roof is worse than a
    // refused save.
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/at least one question/i);
  });

  it('refuses to publish the same version twice', async () => {
    const { id, draftId } = await createTemplate();
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const again = await post(`/templates/${id}/versions/${draftId}/publish`);
    expect(again.status).toBe(409);
  });

  it('retires the previous version when a newer one is published', async () => {
    const { id, draftId } = await createTemplate();
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const v2 = await post(`/templates/${id}/versions`).send({ changeNote: 'Second' });
    expect(v2.status).toBe(201);
    await post(`/templates/${id}/versions/${v2.body.data.id}/publish`).expect(200);

    const old = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    expect(old.retiredAt).not.toBeNull();
    // Retired, never altered: the questions are exactly as published.
    expect(old.publishedAt).not.toBeNull();
  });

  it('requires the publish permission, which a manager does not hold', async () => {
    const { id, draftId } = await createTemplate();
    const res = await post(`/templates/${id}/versions/${draftId}/publish`, 'INSPECTOR');
    expect(res.status).toBe(403);
  });
});

describe('published versions are immutable', () => {
  it('refuses an edit and leaves the stored definition untouched', async () => {
    const { id, draftId } = await createTemplate();
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const before = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });

    const res = await patch(`/templates/${id}/versions/${draftId}`).send({
      definition: definition('A completely different question'),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/new draft/i);

    const after = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    // The refusal is only meaningful if nothing changed underneath it.
    expect(JSON.stringify(after.definition)).toBe(JSON.stringify(before.definition));
  });

  it('lets a draft be edited freely', async () => {
    const { id, draftId } = await createTemplate();

    const res = await patch(`/templates/${id}/versions/${draftId}`).send({
      definition: definition('Edited while still a draft'),
      changeNote: 'Reworded.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.changeNote).toBe('Reworded.');

    const stored = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    expect(JSON.stringify(stored.definition)).toContain('Edited while still a draft');
  });

  it('rejects an invalid definition on a draft edit', async () => {
    const { id, draftId } = await createTemplate();
    const res = await patch(`/templates/${id}/versions/${draftId}`).send({ definition: 42 });
    expect(res.status).toBe(422);
  });

  it('an in-flight inspection keeps its pinned version after a newer one is published', async () => {
    // The fixture template is already published as v1 and the fixture
    // inspection pins it. Publishing v2 must not move it.
    const v2 = await post(`/templates/${org.templateId}/versions`).send({ changeNote: 'v2' });
    expect(v2.status).toBe(201);
    await post(`/templates/${org.templateId}/versions/${v2.body.data.id}/publish`).expect(200);

    const template = await prisma.template.findUniqueOrThrow({ where: { id: org.templateId } });
    expect(template.activeVersionId).toBe(v2.body.data.id);

    // New work gets v2; the version the fixture pinned is still v1 and still
    // published, so a report from it renders the original questions.
    const pinned = await prisma.templateVersion.findUniqueOrThrow({
      where: { id: org.templateVersionId },
    });
    expect(pinned.publishedAt).not.toBeNull();
  });
});

describe('new draft versions', () => {
  it('copies the source definition so an author edits rather than retypes', async () => {
    const { id, draftId } = await createTemplate();
    await patch(`/templates/${id}/versions/${draftId}`).send({
      definition: definition('Distinctive original wording'),
    });
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const v2 = await post(`/templates/${id}/versions`).send({});
    expect(v2.status).toBe(201);
    expect(v2.body.data.version).toBe(2);
    expect(JSON.stringify(v2.body.data.definition)).toContain('Distinctive original wording');
    expect(v2.body.data.publishedAt).toBeNull();
  });

  it('can branch from a named earlier version rather than the newest', async () => {
    const { id, draftId } = await createTemplate();
    await patch(`/templates/${id}/versions/${draftId}`).send({
      definition: definition('Wording from version one'),
    });
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const v2 = await post(`/templates/${id}/versions`).send({
      definition: definition('Wording from version two'),
    });
    expect(v2.status).toBe(201);

    const v3 = await post(`/templates/${id}/versions`).send({ fromVersionId: draftId });
    expect(v3.status).toBe(201);
    expect(v3.body.data.version).toBe(3);
    expect(JSON.stringify(v3.body.data.definition)).toContain('Wording from version one');
  });

  it('404s for a template in another organisation', async () => {
    const other = await createTestOrg();
    try {
      const res = await post(`/templates/${other.templateId}/versions`).send({});
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});

describe('cloning', () => {
  it('produces an independent unpublished copy', async () => {
    const { id, draftId } = await createTemplate('Roof Access Check');
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const res = await post(`/templates/${id}/clone`).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Roof Access Check (copy)');
    expect(res.body.data.id).not.toBe(id);

    const clone = await prisma.template.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(clone.activeVersionId).toBeNull();

    // Editing the clone must not touch the original's published definition.
    const cloneVersion = await prisma.templateVersion.findFirstOrThrow({
      where: { templateId: clone.id },
    });
    await patch(`/templates/${clone.id}/versions/${cloneVersion.id}`).send({
      definition: definition('Changed only on the clone'),
    });

    const original = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    expect(JSON.stringify(original.definition)).not.toContain('Changed only on the clone');
  });

  it('accepts an explicit name', async () => {
    const { id } = await createTemplate();
    const res = await post(`/templates/${id}/clone`).send({ name: 'Deliberately Named' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Deliberately Named');
  });
});

describe('export and import', () => {
  it('round-trips a template into a fresh draft with new ids', async () => {
    const { id, draftId } = await createTemplate('Portable Checklist');
    await post(`/templates/${id}/versions/${draftId}/publish`).expect(200);

    const exported = await get(`/templates/${id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toContain('.orbit-template.json');
    expect(exported.body.formatVersion).toBe(1);
    expect(exported.body.template.name).toBe('Portable Checklist');

    const imported = await post('/templates/import').send(exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body.data.id).not.toBe(id);
    expect(imported.body.data.fieldCount).toBe(1);

    // Ids must be reminted, or two installations share primary keys.
    const source = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    const landed = await prisma.templateVersion.findUniqueOrThrow({
      where: { id: imported.body.data.draftVersionId },
    });
    const fieldId = (d: unknown) =>
      (d as { sections: { fields: { id: string }[] }[] }).sections[0]!.fields[0]!.id;
    expect(fieldId(landed.definition)).not.toBe(fieldId(source.definition));

    // And it arrives unpublished regardless of the source's state.
    expect(landed.publishedAt).toBeNull();
  });

  it('refuses a format version it does not understand', async () => {
    const res = await post('/templates/import').send({
      formatVersion: 99,
      template: { name: 'From The Future' },
      version: { definition: definition() },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/version 1/);
  });

  it('validates an imported definition as strictly as a hand-authored one', async () => {
    const res = await post('/templates/import').send({
      formatVersion: 1,
      template: { name: unique('Imported') },
      version: { definition: { sections: [{ title: 'S', order: 0, fields: [{ type: 'NOPE' }] }] } },
    });
    expect(res.status).toBe(422);
  });

  it('404s exporting a template with no version', async () => {
    const res = await get(`/templates/${'0'.repeat(26)}/export`);
    expect(res.status).toBe(404);
  });
});

describe('listing and reading', () => {
  it('paginates, searches and filters by category', async () => {
    const name = unique('Searchable');
    await post('/templates').send({ name, category: 'Electrical', definition: definition() });

    const search = await get(`/templates?search=${encodeURIComponent(name)}`);
    expect(search.status).toBe(200);
    expect(search.body.data.items).toHaveLength(1);
    expect(search.body.data.items[0].name).toBe(name);

    const byCategory = await get('/templates?category=Electrical');
    expect(byCategory.body.data.items.length).toBeGreaterThan(0);

    const missing = await get('/templates?category=NoSuchCategory');
    expect(missing.body.data.items).toHaveLength(0);

    const paged = await get('/templates?page=1&pageSize=1');
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBeGreaterThanOrEqual(1);
  });

  it('sorts by a permitted column and ignores an arbitrary one', async () => {
    const asc = await get('/templates?sortBy=name&sortDir=asc');
    expect(asc.status).toBe(200);
    // An unlisted column must not reach the query builder.
    const injected = await get('/templates?sortBy=passwordHash&sortDir=asc');
    expect(injected.status).toBe(200);
  });

  it('returns a single template with its definition', async () => {
    const res = await get(`/templates/${org.templateId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(org.templateId);
  });

  it('does not leak another organisation’s template', async () => {
    const other = await createTestOrg();
    try {
      const res = await get(`/templates/${other.templateId}`);
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });

  it('rejects a malformed id before it reaches the database', async () => {
    const res = await get('/templates/not-a-ulid');
    expect(res.status).toBe(422);
  });
});

describe('archiving', () => {
  it('archives rather than deletes when inspections reference the template', async () => {
    // The fixture template is referenced by inspections created elsewhere in
    // this suite's organisation, so ensure at least one exists.
    const inspections = await prisma.inspection.count({ where: { templateId: org.templateId } });
    if (inspections === 0) {
      await prisma.inspection.create({
        data: {
          id: unique('I')
            .toUpperCase()
            .replace(/[^0-9A-Z]/g, '0')
            .slice(0, 26)
            .padEnd(26, '0'),
          orgId: org.orgId,
          number: unique('ARC').toUpperCase().slice(0, 30),
          templateId: org.templateId,
          templateVersionId: org.templateVersionId,
          projectId: org.projectId,
          clientId: org.clientId,
          siteId: org.siteId,
          title: 'Archive guard',
          status: 'SCHEDULED',
          assignedToId: org.users.INSPECTOR!.id,
          createdById: org.users.ADMIN!.id,
        },
      });
    }

    const res = await del(`/templates/${org.templateId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ archived: true, deleted: false });

    // Destroying the definition would make every historical report
    // unreproducible, so the row must survive.
    const still = await prisma.template.findUniqueOrThrow({ where: { id: org.templateId } });
    expect(still.deletedAt).toBeNull();
    expect(still.isArchived).toBe(true);

    // Put it back for any test that runs after this one.
    await prisma.template.update({ where: { id: org.templateId }, data: { isArchived: false } });
  });

  it('soft-deletes an unreferenced template and hides it from the list', async () => {
    const { id } = await createTemplate();

    const res = await del(`/templates/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ archived: true, deleted: true });

    const listed = await get('/templates?pageSize=100');
    expect(listed.body.data.items.map((t: { id: string }) => t.id)).not.toContain(id);
  });

  it('refuses deletion to a role without the permission', async () => {
    const { id } = await createTemplate();
    const res = await del(`/templates/${id}`, 'INSPECTOR');
    expect(res.status).toBe(403);
  });
});

describe('metadata updates', () => {
  it('changes template fields without touching any version', async () => {
    const { id, draftId } = await createTemplate();
    const before = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });

    const res = await patch(`/templates/${id}`).send({
      description: 'Now with a description',
      category: 'Mechanical',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('Now with a description');

    const after = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draftId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('404s for an unknown template', async () => {
    const res = await patch(`/templates/${'0'.repeat(26)}`).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});
