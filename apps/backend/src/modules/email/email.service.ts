/**
 * The messages this application sends.
 *
 * One function per message, each taking the domain values it needs rather than
 * a pre-rendered template. Callers in `auth.service` and `users.routes` should
 * not know what a preheader is, and a template change should not require
 * touching a route.
 *
 * Every function resolves to a `SendResult` and never throws — see `mailer.ts`
 * for why. The caller decides whether an undelivered message matters: for a
 * password reset it does not (the code is already stored), for an invitation it
 * does (the recipient has no other way in), and each caller reflects that.
 */

import { env } from '../../config/env.js';
import { sendEmail, type SendResult } from './mailer.js';
import * as templates from './templates.js';

export type { SendResult };

export function sendPasswordResetEmail(input: {
  to: string;
  firstName: string;
  code: string;
}): Promise<SendResult> {
  return sendEmail(
    input.to,
    templates.passwordReset({
      firstName: input.firstName,
      code: input.code,
      ttlSeconds: env.OTP_TTL_SECONDS,
    }),
  );
}

export function sendEmailVerification(input: {
  to: string;
  firstName: string;
  code: string;
}): Promise<SendResult> {
  return sendEmail(
    input.to,
    templates.emailVerification({
      firstName: input.firstName,
      code: input.code,
      ttlSeconds: env.OTP_TTL_SECONDS,
    }),
  );
}

export function sendInvitationEmail(input: {
  to: string;
  firstName: string;
  organisationName: string;
  invitedByName: string;
  token: string;
}): Promise<SendResult> {
  return sendEmail(
    input.to,
    templates.invitation({
      firstName: input.firstName,
      organisationName: input.organisationName,
      invitedByName: input.invitedByName,
      token: input.token,
    }),
  );
}

export function sendMagicLinkEmail(input: {
  to: string;
  firstName: string;
  token: string;
}): Promise<SendResult> {
  return sendEmail(
    input.to,
    templates.magicLink({
      firstName: input.firstName,
      token: input.token,
      ttlSeconds: env.MAGIC_LINK_TTL_SECONDS,
    }),
  );
}

export function sendWelcomeEmail(input: {
  to: string;
  firstName: string;
  organisationName: string;
}): Promise<SendResult> {
  return sendEmail(
    input.to,
    templates.welcome({
      firstName: input.firstName,
      organisationName: input.organisationName,
    }),
  );
}

/**
 * Whether this installation can actually deliver mail.
 *
 * Consulted by the flows that are useless without it — an invitation with no
 * password creates an account the recipient can never reach — so they can
 * refuse up front rather than appearing to succeed.
 */
export function emailIsConfigured(): boolean {
  if (env.MAIL_TRANSPORT === 'resend') return Boolean(env.RESEND_API_KEY);
  if (env.MAIL_TRANSPORT === 'smtp') return Boolean(env.SMTP_URL);
  return false;
}
