/**
 * Email templates.
 *
 * Every message is built as both HTML and plain text. That is not politeness:
 * a plain-text alternative materially improves deliverability, and a field
 * inspector reading mail on a locked-down corporate client may never see the
 * HTML part at all.
 *
 * The HTML deliberately looks like 2005 — tables, inline styles, no external
 * assets. Mail clients strip `<style>` blocks, ignore flexbox, and block remote
 * images by default, so anything more modern degrades to unstyled text in
 * Outlook. Inline styles on tables is the format that survives.
 *
 * Nothing here interpolates a value without escaping it. A user-supplied name
 * lands in the HTML body, so an unescaped one is stored XSS delivered by email.
 */

import { env } from '../../config/env.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Escape for an HTML text node. Never interpolate user data without this. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND = '#1B5CF0';
const INK = '#0B1220';
const MUTED = '#6B7A94';

/**
 * Wrap body content in the shared shell.
 *
 * `preheader` is the grey line a client shows next to the subject in the inbox
 * list. Left unset, clients fill it with whatever text comes first — usually
 * "View this email in your browser" or a bare URL, which looks like spam.
 */
function layout(options: { title: string; preheader: string; body: string }): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(options.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:#F5F7FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">`,
    // Hidden preheader: shown in the inbox list, never in the opened message.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(options.preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FB;padding:24px 12px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;border:1px solid #E4EAF2;">',
    `<tr><td style="padding:28px 32px 8px 32px;">`,
    `<div style="font-size:18px;font-weight:700;color:${BRAND};letter-spacing:-0.2px;">Orbit Field</div>`,
    '</td></tr>',
    `<tr><td style="padding:8px 32px 28px 32px;color:${INK};font-size:15px;line-height:1.55;">`,
    options.body,
    '</td></tr>',
    '</table>',
    `<div style="max-width:560px;margin:16px auto 0;color:${MUTED};font-size:12px;line-height:1.5;text-align:center;">`,
    'This message was sent by Orbit Field. If you were not expecting it, you can ignore it safely.',
    '</div>',
    '</td></tr></table></body></html>',
  ].join('');
}

/** A button that still renders as a link when CSS is stripped. */
function button(href: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td ` +
    `style="background:${BRAND};border-radius:8px;">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;color:#FFFFFF;` +
    `text-decoration:none;font-weight:600;font-size:15px;">${esc(label)}</a>` +
    '</td></tr></table>'
  );
}

/** A code shown large enough to read off a phone and retype without error. */
function codeBlock(code: string): string {
  return (
    `<div style="margin:24px 0;padding:16px;background:#F5F7FB;border:1px solid #E4EAF2;` +
    `border-radius:8px;text-align:center;font-size:28px;font-weight:700;letter-spacing:6px;` +
    `color:${INK};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(code)}</div>`
  );
}

function p(text: string): string {
  return `<p style="margin:0 0 14px 0;">${text}</p>`;
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m === 1 ? '1 minute' : `${m} minutes`;
}

const link = (path: string, params: Record<string, string>): string => {
  const url = new URL(path, env.APP_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function passwordReset(input: {
  firstName: string;
  code: string;
  ttlSeconds: number;
}): RenderedEmail {
  const expiry = minutes(input.ttlSeconds);
  return {
    subject: 'Reset your Orbit Field password',
    html: layout({
      title: 'Reset your password',
      preheader: `Your reset code expires in ${expiry}.`,
      body: [
        p(`Hello ${esc(input.firstName)},`),
        p('Use this code to set a new password:'),
        codeBlock(input.code),
        p(`The code expires in ${expiry} and can be used once.`),
        p(
          `<strong>If you did not ask to reset your password</strong>, ignore this message — ` +
            'your password has not changed. Nobody can use this code without access to this inbox.',
        ),
      ].join(''),
    }),
    text: [
      `Hello ${input.firstName},`,
      '',
      'Use this code to set a new password:',
      '',
      `    ${input.code}`,
      '',
      `The code expires in ${expiry} and can be used once.`,
      '',
      'If you did not ask to reset your password, ignore this message — your',
      'password has not changed.',
      '',
      '— Orbit Field',
    ].join('\n'),
  };
}

export function emailVerification(input: {
  firstName: string;
  code: string;
  ttlSeconds: number;
}): RenderedEmail {
  const expiry = minutes(input.ttlSeconds);
  return {
    subject: 'Confirm your Orbit Field email address',
    html: layout({
      title: 'Confirm your email address',
      preheader: `Your confirmation code expires in ${expiry}.`,
      body: [
        p(`Hello ${esc(input.firstName)},`),
        p('Confirm this address with the code below:'),
        codeBlock(input.code),
        p(`The code expires in ${expiry}.`),
      ].join(''),
    }),
    text: [
      `Hello ${input.firstName},`,
      '',
      'Confirm this address with the code below:',
      '',
      `    ${input.code}`,
      '',
      `The code expires in ${expiry}.`,
      '',
      '— Orbit Field',
    ].join('\n'),
  };
}

export function invitation(input: {
  firstName: string;
  organisationName: string;
  invitedByName: string;
  token: string;
}): RenderedEmail {
  const url = link('/accept-invite', { token: input.token });
  return {
    subject: `${input.invitedByName} invited you to Orbit Field`,
    html: layout({
      title: 'You have been invited',
      preheader: `Join ${input.organisationName} on Orbit Field.`,
      body: [
        p(`Hello ${esc(input.firstName)},`),
        p(
          `${esc(input.invitedByName)} has invited you to join ` +
            `<strong>${esc(input.organisationName)}</strong> on Orbit Field.`,
        ),
        button(url, 'Set your password'),
        p(
          `<span style="color:${MUTED};font-size:13px;">If the button does not work, paste this ` +
            `into your browser:<br>${esc(url)}</span>`,
        ),
      ].join(''),
    }),
    text: [
      `Hello ${input.firstName},`,
      '',
      `${input.invitedByName} has invited you to join ${input.organisationName} on Orbit Field.`,
      '',
      'Set your password here:',
      url,
      '',
      '— Orbit Field',
    ].join('\n'),
  };
}

export function magicLink(input: {
  firstName: string;
  token: string;
  ttlSeconds: number;
}): RenderedEmail {
  const url = link('/magic', { token: input.token });
  const expiry = minutes(input.ttlSeconds);
  return {
    subject: 'Your Orbit Field sign-in link',
    html: layout({
      title: 'Sign in to Orbit Field',
      preheader: `This link expires in ${expiry}.`,
      body: [
        p(`Hello ${esc(input.firstName)},`),
        p('Use this link to sign in. No password needed.'),
        button(url, 'Sign in'),
        p(`It expires in ${expiry} and works once.`),
        p(
          `<strong>If you did not request this</strong>, ignore it. Anyone with this link can ` +
            'sign in as you, so do not forward it.',
        ),
      ].join(''),
    }),
    text: [
      `Hello ${input.firstName},`,
      '',
      'Use this link to sign in. No password needed.',
      '',
      url,
      '',
      `It expires in ${expiry} and works once.`,
      '',
      'If you did not request this, ignore it. Anyone with this link can sign in',
      'as you, so do not forward it.',
      '',
      '— Orbit Field',
    ].join('\n'),
  };
}

export function welcome(input: { firstName: string; organisationName: string }): RenderedEmail {
  const url = link('/', {});
  return {
    subject: 'Welcome to Orbit Field',
    html: layout({
      title: 'Welcome to Orbit Field',
      preheader: `Your ${input.organisationName} workspace is ready.`,
      body: [
        p(`Hello ${esc(input.firstName)},`),
        p(
          `Your workspace for <strong>${esc(input.organisationName)}</strong> is ready. ` +
            'Inspections you assign will appear on your team’s phones, and their work syncs ' +
            'back whenever they next have signal.',
        ),
        button(url, 'Open the console'),
      ].join(''),
    }),
    text: [
      `Hello ${input.firstName},`,
      '',
      `Your workspace for ${input.organisationName} is ready. Inspections you assign will`,
      'appear on your team’s phones, and their work syncs back whenever they next',
      'have signal.',
      '',
      `Open the console: ${url}`,
      '',
      '— Orbit Field',
    ].join('\n'),
  };
}
