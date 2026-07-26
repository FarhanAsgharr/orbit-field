/**
 * Outbound mail.
 *
 * Three transports behind one interface:
 *
 *  - **resend** — an HTTPS call. The right choice on Vercel, where a function
 *    is frozen between invocations and a pooled SMTP socket is a liability.
 *  - **smtp** — nodemailer, for a self-hosted install or any other provider.
 *  - **log** — writes the message to the application log. This is the default,
 *    and it is a deliberate degradation rather than a stub: before this module
 *    existed, `forgotPassword` minted a one-time code and dropped it on the
 *    floor, so an install with no mail provider had a password reset flow that
 *    silently did nothing. Logging it means an administrator can still recover
 *    an account, and the log line says plainly that delivery is not configured.
 *
 * Sending never throws into the caller. An inspector must be able to reset a
 * password even if the mail provider is down — the reset code is already in the
 * database at that point, and failing the request would only lose the record of
 * it. Failures are logged, counted in metrics, and returned as a result.
 */

import { createTransport, type Transporter } from 'nodemailer';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { increment } from '../observability/metrics.js';
import type { RenderedEmail } from './templates.js';

export interface SendResult {
  delivered: boolean;
  transport: 'resend' | 'smtp' | 'log';
  messageId?: string;
  error?: string;
  attempts: number;
}

let smtpTransport: Transporter | null = null;

function smtp(): Transporter {
  if (!smtpTransport) {
    if (!env.SMTP_URL) {
      throw new Error('MAIL_TRANSPORT is "smtp" but SMTP_URL is not set.');
    }
    // The URL form (`smtps://user:pass@host:465`) is what every provider
    // documents, but nodemailer's typings only expose it through the untyped
    // overload — hence the assertion rather than an options object nobody
    // would recognise from their provider's setup page.
    smtpTransport = createTransport({
      url: env.SMTP_URL,
      // A serverless invocation is short-lived; holding the connection open
      // past the response wastes the provider's connection budget.
      pool: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    } as unknown as Parameters<typeof createTransport>[0]);
  }
  return smtpTransport;
}

async function sendViaResend(to: string, message: RenderedEmail): Promise<string> {
  if (!env.RESEND_API_KEY) {
    throw new Error('MAIL_TRANSPORT is "resend" but RESEND_API_KEY is not set.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(env.MAIL_REPLY_TO ? { reply_to: env.MAIL_REPLY_TO } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) {
    // The status matters to the retry loop: 4xx is a bad request that will fail
    // identically next time, 5xx and 429 are worth retrying.
    const error = new Error(`Resend responded ${response.status}: ${body.message ?? 'unknown'}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return body.id ?? 'unknown';
}

async function sendViaSmtp(to: string, message: RenderedEmail): Promise<string> {
  const info = await smtp().sendMail({
    from: env.MAIL_FROM,
    to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
  });
  return info.messageId;
}

/**
 * Retry only what retrying can fix.
 *
 * A 400 from Resend means the payload is wrong; sending it twice more produces
 * two more 400s and delays the caller. A 429 or a 5xx, or a dropped socket, is
 * transient and worth another attempt.
 */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true; // network-level failures carry no status
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deliver one message.
 *
 * Resolves rather than rejects, always. Callers are flows like "issue a
 * password reset" where the security-relevant work is already committed and the
 * mail is a notification of it.
 */
export async function sendEmail(to: string, message: RenderedEmail): Promise<SendResult> {
  const transport = env.MAIL_TRANSPORT;

  if (transport === 'log') {
    // Deliberately readable: on an install with no provider this log line is
    // how an administrator recovers an account. The body is included because a
    // reset code that only exists in a database row nobody can read is useless.
    logger.warn(
      { to, subject: message.subject, body: message.text },
      'email not sent — MAIL_TRANSPORT is "log" and no provider is configured',
    );
    increment('orbit_emails_total', { transport: 'log', outcome: 'logged' });
    return { delivered: false, transport: 'log', attempts: 0 };
  }

  let lastError = '';
  for (let attempt = 1; attempt <= env.MAIL_MAX_ATTEMPTS; attempt++) {
    try {
      const messageId =
        transport === 'resend' ? await sendViaResend(to, message) : await sendViaSmtp(to, message);

      increment('orbit_emails_total', { transport, outcome: 'sent' });
      logger.info({ to, subject: message.subject, transport, attempt }, 'email sent');
      return { delivered: true, transport, messageId, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const retryable = isRetryable(err);

      if (!retryable || attempt === env.MAIL_MAX_ATTEMPTS) {
        increment('orbit_emails_total', { transport, outcome: 'failed' });
        logger.error(
          { to, subject: message.subject, transport, attempt, err, retryable },
          'email delivery failed',
        );
        return { delivered: false, transport, error: lastError, attempts: attempt };
      }

      // Exponential backoff: 250ms, 500ms, 1s. Short, because a request is
      // waiting on this and the reset code is already safely stored.
      await wait(250 * 2 ** (attempt - 1));
    }
  }

  return { delivered: false, transport, error: lastError, attempts: env.MAIL_MAX_ATTEMPTS };
}

/** Reset the memoised SMTP transport. Tests only. */
export function resetMailer(): void {
  smtpTransport = null;
}
