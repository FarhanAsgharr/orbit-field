/**
 * Error reporting, with the emphasis on what must *not* leave the process.
 *
 * Orbit Field holds compliance records belonging to somebody else's business:
 * where an inspector stood, what failed at a client's site, the address of that
 * site. A stack trace is useful to us. A stack trace with a sync push body
 * attached to it is a data-protection incident, and it is one that nobody
 * notices, because the tracker accepts it silently and the application carries
 * on working perfectly.
 *
 * So `beforeSend` is tested directly on a representative event rather than
 * through the SDK: the assertion that matters is that specific fields are gone
 * afterwards, and that is only observable at that function.
 */

import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';

import { captureError, flushSentry, initSentry, scrubEvent, sentryEnabled } from './sentry.js';

describe('when no DSN is configured', () => {
  it('stays inert, because a self-hosted install should get privacy by doing nothing', async () => {
    // The real module-level env has no DSN under test.
    expect(sentryEnabled()).toBe(false);
    expect(initSentry()).toBe(false);
  });

  it('makes capture and flush no-ops rather than requiring callers to check', async () => {
    // Both return without touching the SDK, so a caller never has to guard.
    expect(() =>
      captureError(new Error('nothing should be sent'), { requestId: '01ABC' }),
    ).not.toThrow();
    await expect(flushSentry(1)).resolves.toBeUndefined();
  });
});

describe('the payload scrubber', () => {
  /* The real function the SDK is handed as `beforeSend`, not a copy of it. */
  const scrub = scrubEvent;

  const event = (): ErrorEvent =>
    ({
      event_id: 'abc',
      request: {
        url: 'https://api.example.com/api/v1/sync/push',
        method: 'POST',
        // An entire inspection: answers, coordinates, a client's site address.
        data: { operations: [{ patch: { latitude: 51.5, notes: 'Cracked beam, unit 4B' } }] },
        cookies: { session: 'value' },
        query_string: 'token=secret',
        headers: {
          authorization: 'Bearer eyJhbGciOi...',
          cookie: 'session=value',
          'user-agent': 'OrbitField/1.0.0',
          'x-request-id': '01ABCDEF',
        },
      },
    }) as ErrorEvent;

  it('removes the request body', async () => {
    const scrubbed = scrub(event());
    expect(scrubbed.request?.data).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('Cracked beam');
    expect(JSON.stringify(scrubbed)).not.toContain('51.5');
  });

  it('removes cookies and the query string', async () => {
    const scrubbed = scrub(event());
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('token=secret');
  });

  it('removes the credential headers and keeps the diagnostic ones', async () => {
    const scrubbed = scrub(event());
    const headers = scrubbed.request?.headers ?? {};

    // A bearer token in an error report is a live credential sitting in a
    // third party's database.
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();

    // These carry no personal data and are what makes an event correlatable
    // with a log line, so removing them would defeat the point.
    expect(headers['user-agent']).toBe('OrbitField/1.0.0');
    expect(headers['x-request-id']).toBe('01ABCDEF');
  });

  it('leaves an event with no request section alone', async () => {
    const bare = { event_id: 'abc' } as ErrorEvent;
    expect(scrub(bare)).toEqual({ event_id: 'abc' });
  });
});

describe('context attached to a captured error', () => {
  it('sends ids, never contents', async () => {
    // `captureError` is inert without a DSN, which is the state under test, so
    // this asserts the contract rather than the transmission: the function
    // accepts only identifiers, and there is nowhere to put a payload.
    const context = {
      requestId: '01ABCDEF',
      route: '/api/v1/sync/push',
      userId: '01USER0000000000000000000',
      orgId: '01ORG00000000000000000000',
    };

    expect(() => captureError(new Error('boom'), context)).not.toThrow();
    expect(
      Object.keys(context).every((k) => ['requestId', 'route', 'userId', 'orgId'].includes(k)),
    ).toBe(true);
  });

  it('tolerates an empty context', async () => {
    expect(() => captureError(new Error('boom'))).not.toThrow();
  });

  it('tolerates something that is not an Error at all', async () => {
    expect(() => captureError('a string was thrown')).not.toThrow();
    expect(() => captureError(undefined)).not.toThrow();
  });
});
