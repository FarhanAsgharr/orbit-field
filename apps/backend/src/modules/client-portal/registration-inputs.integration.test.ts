/**
 * What a real person types into the registration form.
 *
 * Written to chase a production report — "I enter all the information and it
 * says an unexpected error occurred" — and kept because it found two, and
 * because the shape of both is easy to reintroduce.
 *
 * In production every 5xx is rewritten to that one sentence, so a customer
 * cannot tell an overflowing column from a dead database, and neither can
 * anybody reading the report. The only way to find it was to run the same
 * inputs somewhere the real error still shows.
 *
 * Both defects were **derived** values outliving their validation:
 *
 *  - `website` is checked at 300 characters and then has `https://` prepended,
 *    so an address just under the limit overflowed `varchar(300)`.
 *  - `contactName` is checked at 120 and then split into `firstName` and
 *    `lastName`, which are `varchar(100)` each, so one long unbroken name
 *    overflowed the first.
 *
 * Neither is reachable through a field's own `.max()`, which is exactly why
 * the class is worth a test rather than a fix. The rule it encodes: validate
 * what you are about to store, not what you were given.
 *
 * The last two cases cover uniqueness probes, where the same mistake appears
 * as a constraint that ignores `deletedAt` and a probe that does not.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

let org: TestOrg;
/**
 * The company these submissions register with.
 *
 * Named explicitly rather than left out: the portal refuses to guess when an
 * installation carries several companies, which is what stopped customers
 * being filed under whichever one happened to be oldest.
 */
let orgSlug = '';

beforeAll(async () => {
  org = await createTestOrg();
  orgSlug = (
    await prisma.organization.findUniqueOrThrow({
      where: { id: org.orgId },
      select: { slug: true },
    })
  ).slug;
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const base = (o: Record<string, unknown> = {}) => ({
  organizationSlug: orgSlug,
  companyName: `Repro ${unique('co')}`,
  contactName: 'Muhammad Farhan',
  email: `${unique('repro')}@example.test`,
  contactPhone: '+92 300 1234567',
  country: 'Pakistan',
  state: 'Punjab',
  city: 'Lahore',
  address: '123 Main Boulevard Gulberg III',
  password: 'Str0ng-Portal-Pass!9x',
  ...o,
});

/** Realistic things a person types, plus the states the database can be in. */
const cases: Array<[string, Record<string, unknown>]> = [
  ['website at the 300-char limit', { website: `${'a'.repeat(290)}.com` }],
  ['contactName one long word (120)', { contactName: 'C'.repeat(120) }],
  ['single-word contact name', { contactName: 'Farhan' }],
  ['contact name with three words', { contactName: 'Muhammad Farhan Asghar' }],
  ['contact name with extra spaces', { contactName: '  Muhammad   Farhan  ' }],
  ['email with a plus tag', { email: `${unique('plus')}+portal@example.test` }],
  ['uppercase email', { email: `${unique('UP').toUpperCase()}@EXAMPLE.TEST` }],
  ['website with www', { website: 'www.hanansoftware.com' }],
  ['website already https', { website: 'https://hanansoftware.com' }],
  ['website with a path', { website: 'hanansoftware.com/about' }],
  ['local phone format', { contactPhone: '03001234567' }],
  ['phone with dashes', { contactPhone: '0300-1234567' }],
  ['industry Other', { industry: 'Other' }],
  ['company name non-latin', { companyName: 'حنان سافٹ ویئر ہاؤس' }],
  ['company name with punctuation only', { companyName: '&&& ---' }],
  ['company name with an ampersand', { companyName: 'Asghar & Sons' }],
  ['address with newlines', { address: '123 Main Boulevard\nGulberg III\nLahore' }],
  ['notes at 2000', { notes: 'M'.repeat(2000) }],
];

describe('registration input', () => {
  it('never returns a 500, whatever is typed into the form', async () => {
    const failures: string[] = [];
    for (const [label, override] of cases) {
      const res = await request(server).post(`${api}/portal/register`).send(base(override));
      // A refusal is fine — being unable to say why is not. Anything the form
      // will not accept must come back as a 4xx naming the field.
      if (res.status >= 500) failures.push(`${label} -> ${res.status}`);
      if (res.status >= 400) {
        expect(res.body?.error?.fields, `${label} should name the field at fault`).toBeTruthy();
      }
    }
    expect(failures).toEqual([]);
  });

  it('handles an email held by a soft-deleted user', async () => {
    const email = `${unique('softdel')}@example.test`;
    const first = await request(server).post(`${api}/portal/register`).send(base({ email }));
    expect(first.status).toBe(201);

    // The unique index is (orgId, email) and knows nothing about deletedAt.
    await prisma.user.updateMany({ where: { email }, data: { deletedAt: new Date() } });

    const second = await request(server).post(`${api}/portal/register`).send(base({ email }));

    expect(second.status).toBe(409);
    // Not "a record with this orgId, email already exists" — that names a
    // database column at somebody trying to sign up, and tells them nothing
    // they can act on.
    expect(second.body.error.message).toMatch(/removed/i);
    expect(second.body.error.message).not.toMatch(/orgId/);
  });

  it('handles a company name whose code a deleted client holds', async () => {
    const companyName = `Codeclash ${unique('cc')}`;
    const first = await request(server).post(`${api}/portal/register`).send(base({ companyName }));
    expect(first.status).toBe(201);
    await prisma.client.updateMany({
      where: { id: first.body.data.clientId },
      data: { deletedAt: new Date() },
    });

    const second = await request(server).post(`${api}/portal/register`).send(base({ companyName }));

    // The derived code is already taken by the deleted row, and the constraint
    // does not care that it is deleted, so a fresh one has to be found.
    expect(second.status).toBe(201);
  });
});
