/**
 * Client invitations, as they cross the wire.
 *
 * Three programs need these shapes — the API that produces them, the console
 * that lists them, and the portal that redeems one — and until this file
 * existed each kept its own copy. Duplicated shapes agree on the day they are
 * written and drift on the day somebody adds a field, silently, because
 * nothing compares them.
 *
 * Nothing here carries a token. The raw value is returned exactly once, by the
 * endpoint that creates an invitation, and is never stored or re-served — so a
 * type that could hold one everywhere would misdescribe every other response.
 */

/** Where an invitation stands, as staff see it. */
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

/**
 * An invitation in the console's list.
 *
 * Dates are ISO strings rather than `Date`: this is the shape after JSON, and
 * pretending otherwise pushes a conversion onto every reader.
 */
export interface ClientInvitationSummary {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: InvitationStatus;
  createdBy: { firstName: string; lastName: string } | null;
}

/**
 * What the recipient is shown before choosing a password.
 *
 * Only what they already know — their own name and address, and who invited
 * them — so a guessed link discloses nothing they did not have.
 */
export interface InvitationDetails {
  organizationName: string;
  organizationSlug: string;
  clientName: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  expiresAt: string;
}

/**
 * The response to creating an invitation.
 *
 * `token` appears here and nowhere else in the API. `invitePath` is a path
 * rather than a URL because the API does not know where the portal is
 * deployed; the console owns the origin and joins the two.
 */
export interface CreatedInvitation {
  id: string;
  email: string;
  expiresAt: string;
  invitePath: string;
  token: string;
}

/** What an administrator submits to invite somebody. */
export interface CreateInvitationRequest {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Overrides the deployment default. One hour to ninety days. */
  expiresInHours?: number;
}

/** What the recipient submits to activate the account. */
export interface AcceptInvitationRequest {
  password: string;
  firstName?: string;
  lastName?: string;
  /** The company whose portal the link was opened at. */
  organizationSlug?: string;
}
