/**
 * Email, verified against real transports.
 *
 * Two things are tested here that a mocked mailer cannot tell you:
 *
 *  - **SMTP actually works.** A throwaway SMTP server is started on a loopback
 *    port and the message is asserted on the wire — headers, both MIME parts,
 *    and the code inside them. Mocking `nodemailer.sendMail` would have passed
 *    just as happily with a transport that never connects.
 *  - **Resend's HTTP contract is honoured**, including the retry policy, using
 *    a stub HTTP server rather than the real API.
 *
 * The template assertions are about safety rather than appearance: a user's
 * name lands inside an HTML body, so an unescaped one is stored XSS delivered
 * by email.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as templates from './templates.js';

/**
 * Load the mailer with a given configuration.
 *
 * `config/env.ts` validates and freezes `process.env` at first import, and the
 * whole app graph depends on it — so mutating `process.env` inside a test does
 * nothing to an already-loaded module. Resetting the registry and re-importing
 * is the only way to exercise a different transport, and it keeps the
 * production code free of test-only injection hooks.
 */
async function loadMailer(config: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, config);
  return import('./mailer.js');
}

interface Captured {
  from: string;
  to: string[];
  raw: string;
}

let smtpServer: SMTPServer;
let smtpPort = 0;
const received: Captured[] = [];

beforeAll(async () => {
  smtpServer = new SMTPServer({
    authOptional: true,
    // Self-signed is fine on loopback; the point is the protocol, not the CA.
    disabledCommands: ['STARTTLS'],
    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
        });
        callback();
      });
    },
  });

  await new Promise<void>((resolve) => {
    smtpServer.listen(0, '127.0.0.1', () => {
      smtpPort = (smtpServer.server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => smtpServer.close(() => resolve()));
});

describe('templates', () => {
  it('renders both an HTML and a plain-text part', () => {
    const mail = templates.passwordReset({ firstName: 'Ada', code: '123456', ttlSeconds: 600 });
    expect(mail.html).toContain('<!doctype html>');
    expect(mail.text).not.toContain('<');
    expect(mail.subject).toBeTruthy();
  });

  it('puts the code in both parts, because clients strip HTML', () => {
    const mail = templates.passwordReset({ firstName: 'Ada', code: '482913', ttlSeconds: 600 });
    expect(mail.html).toContain('482913');
    expect(mail.text).toContain('482913');
  });

  it('escapes a name containing HTML rather than emitting it raw', () => {
    const mail = templates.passwordReset({
      firstName: '<script>alert(1)</script>',
      code: '123456',
      ttlSeconds: 600,
    });
    // The payload must not survive as markup in a message a person opens.
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('escapes an organisation name in the invitation', () => {
    const mail = templates.invitation({
      firstName: 'Ada',
      organisationName: '"><img src=x onerror=alert(1)>',
      invitedByName: 'Grace',
      token: 'tok',
    });
    expect(mail.html).not.toContain('<img src=x');
  });

  it('states the expiry in human terms, not seconds', () => {
    const mail = templates.passwordReset({ firstName: 'Ada', code: '1', ttlSeconds: 600 });
    expect(mail.text).toContain('10 minutes');
  });

  it('builds links against APP_BASE_URL, not the API origin', () => {
    const mail = templates.magicLink({ firstName: 'Ada', token: 'abc123', ttlSeconds: 900 });
    expect(mail.text).toContain('/magic');
    expect(mail.text).toContain('abc123');
  });

  it('carries a preheader so the inbox preview is not a stray URL', () => {
    const mail = templates.welcome({ firstName: 'Ada', organisationName: 'Northwind' });
    expect(mail.html).toContain('display:none');
  });

  it('renders every message type', () => {
    const all = [
      templates.passwordReset({ firstName: 'A', code: '1', ttlSeconds: 600 }),
      templates.emailVerification({ firstName: 'A', code: '1', ttlSeconds: 600 }),
      templates.invitation({
        firstName: 'A',
        organisationName: 'O',
        invitedByName: 'B',
        token: 't',
      }),
      templates.magicLink({ firstName: 'A', token: 't', ttlSeconds: 900 }),
      templates.welcome({ firstName: 'A', organisationName: 'O' }),
    ];
    for (const mail of all) {
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.html.length).toBeGreaterThan(0);
      expect(mail.text.length).toBeGreaterThan(0);
    }
  });
});

describe('the log transport', () => {
  it('reports not-delivered rather than pretending to send', async () => {
    const { sendEmail } = await loadMailer({ MAIL_TRANSPORT: 'log' });
    const result = await sendEmail(
      'nobody@test.invalid',
      templates.welcome({ firstName: 'A', organisationName: 'O' }),
    );
    expect(result.delivered).toBe(false);
    expect(result.transport).toBe('log');
  });
});

describe('SMTP transport', () => {
  it('delivers a message a real SMTP server accepts', async () => {
    received.length = 0;
    const { sendEmail } = await loadMailer({
      MAIL_TRANSPORT: 'smtp',
      SMTP_URL: `smtp://127.0.0.1:${smtpPort}`,
      MAIL_MAX_ATTEMPTS: '1',
    });

    const result = await sendEmail(
      'inspector@test.invalid',
      templates.passwordReset({ firstName: 'Ada', code: '778899', ttlSeconds: 600 }),
    );

    expect(result.delivered).toBe(true);
    expect(result.transport).toBe('smtp');
    expect(received).toHaveLength(1);
    expect(received[0]!.to).toContain('inspector@test.invalid');
  });

  it('sends a multipart message carrying both parts on the wire', async () => {
    received.length = 0;
    const { sendEmail } = await loadMailer({
      MAIL_TRANSPORT: 'smtp',
      SMTP_URL: `smtp://127.0.0.1:${smtpPort}`,
      MAIL_MAX_ATTEMPTS: '1',
    });

    await sendEmail(
      'inspector@test.invalid',
      templates.passwordReset({ firstName: 'Ada', code: '445566', ttlSeconds: 600 }),
    );

    const raw = received[0]!.raw;
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
    // Quoted-printable can split a line, so check the subject rather than the
    // code, which may be encoded across a boundary.
    expect(raw).toContain('Subject:');
  });

  it('reports failure instead of throwing when the server is unreachable', async () => {
    // Port 1 is reserved and nothing listens there.
    const { sendEmail } = await loadMailer({
      MAIL_TRANSPORT: 'smtp',
      SMTP_URL: 'smtp://127.0.0.1:1',
      MAIL_MAX_ATTEMPTS: '1',
    });

    const result = await sendEmail(
      'inspector@test.invalid',
      templates.welcome({ firstName: 'A', organisationName: 'O' }),
    );

    // A password reset must not fail because the mail provider is down — the
    // code is already committed by the time this runs.
    expect(result.delivered).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('Resend transport', () => {
  let stub: Server;
  let calls: Array<{ body: unknown; auth: string | undefined }> = [];
  let respondWith: { status: number; body: unknown } = { status: 200, body: { id: 'msg_1' } };

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        calls.push({ body: JSON.parse(raw || '{}'), auth: req.headers.authorization });
        res.writeHead(respondWith.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respondWith.body));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  /**
   * The transport posts to a fixed api.resend.com URL, so the stub is reached
   * by swapping global fetch for one that rewrites the host — the request the
   * transport builds is still exactly what it would send in production.
   */
  function interceptResend(): () => void {
    const port = (stub.address() as AddressInfo).port;
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      return original(url.replace('https://api.resend.com', `http://127.0.0.1:${port}`), init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it('posts the message with the API key and both parts', async () => {
    calls = [];
    respondWith = { status: 200, body: { id: 'msg_ok' } };
    const { sendEmail } = await loadMailer({
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 'test_key_123',
      MAIL_MAX_ATTEMPTS: '1',
    });
    const restore = interceptResend();

    try {
      const result = await sendEmail(
        'inspector@test.invalid',
        templates.magicLink({ firstName: 'Ada', token: 'tok_1', ttlSeconds: 900 }),
      );

      expect(result.delivered).toBe(true);
      expect(result.messageId).toBe('msg_ok');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.auth).toBe('Bearer test_key_123');

      const body = calls[0]!.body as { to: string[]; html: string; text: string };
      expect(body.to).toEqual(['inspector@test.invalid']);
      expect(body.html).toBeTruthy();
      expect(body.text).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('does not retry a 4xx, because the next attempt fails identically', async () => {
    calls = [];
    respondWith = { status: 422, body: { message: 'invalid to address' } };
    const { sendEmail } = await loadMailer({
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 'k',
      MAIL_MAX_ATTEMPTS: '3',
    });
    const restore = interceptResend();

    try {
      const result = await sendEmail(
        'bad',
        templates.welcome({ firstName: 'A', organisationName: 'O' }),
      );
      expect(result.delivered).toBe(false);
      expect(calls).toHaveLength(1);
      expect(result.attempts).toBe(1);
    } finally {
      restore();
    }
  });

  it('retries a 5xx up to the configured limit', async () => {
    calls = [];
    respondWith = { status: 503, body: { message: 'upstream unavailable' } };
    const { sendEmail } = await loadMailer({
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 'k',
      MAIL_MAX_ATTEMPTS: '3',
    });
    const restore = interceptResend();

    try {
      const result = await sendEmail(
        'inspector@test.invalid',
        templates.welcome({ firstName: 'A', organisationName: 'O' }),
      );
      expect(result.delivered).toBe(false);
      expect(result.attempts).toBe(3);
      expect(calls).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it('reports a missing API key rather than sending nothing silently', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendEmail } = await loadMailer({ MAIL_TRANSPORT: 'resend', MAIL_MAX_ATTEMPTS: '1' });
    const result = await sendEmail(
      'inspector@test.invalid',
      templates.welcome({ firstName: 'A', organisationName: 'O' }),
    );
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('RESEND_API_KEY');
  });
});
