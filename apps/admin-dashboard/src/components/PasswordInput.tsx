/**
 * Password field with a reveal toggle.
 *
 * The eye exists because passwords on a desk keyboard are mistyped constantly,
 * and the alternative — a "confirm password" field — asks the user to type the
 * same thing twice without ever seeing either. Revealing is the better trade.
 *
 * Three details that decide whether this helps or annoys:
 *
 *  - The toggle is a real `<button type="button">`. A `<div>` with an onClick
 *    is invisible to keyboards and screen readers, and a button without an
 *    explicit type submits the form it sits in.
 *  - Its accessible name states the *action*, and `aria-pressed` carries the
 *    state. "Show password" that stays "Show password" after being pressed
 *    leaves a screen reader user with no idea what happened.
 *  - Revealed text reverts to hidden on blur. A password left visible on an
 *    unattended admin console is a shoulder-surfing problem, and the user has
 *    already read what they needed by the time focus leaves.
 */

import React, { forwardRef, useEffect, useId, useState } from 'react';

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  error?: string | null;
  hint?: React.ReactNode;
  /** Keep the value visible after focus leaves. Off by default. */
  persistReveal?: boolean;
}

function EyeIcon({ open }: { open: boolean }): React.ReactElement {
  // Two paths rather than one with a rotation: the struck-through eye needs a
  // genuinely different silhouette to read at 18px.
  return open ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a18 18 0 0 1-2.6 3.3M6.2 7.8A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4-.85"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.9 9.9a3 3 0 0 0 4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="m3 3 18 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    { label, error, hint, persistReveal = false, id, className, onBlur, ...rest },
    ref,
  ) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const [revealed, setRevealed] = useState(false);

    // A disabled field cannot be re-hidden by blurring, so hide it immediately.
    useEffect(() => {
      if (rest.disabled && revealed) setRevealed(false);
    }, [rest.disabled, revealed]);

    return (
      <div className="field">
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>

        <div className={`password${error ? ' password--error' : ''}`}>
          <input
            {...rest}
            ref={ref}
            id={inputId}
            type={revealed ? 'text' : 'password'}
            className={`input password__input${className ? ` ${className}` : ''}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
            onBlur={(event) => {
              if (!persistReveal) setRevealed(false);
              onBlur?.(event);
            }}
          />

          <button
            type="button"
            className="password__toggle"
            // The name is the action; aria-pressed carries the state.
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            aria-controls={inputId}
            disabled={rest.disabled}
            // Prevents the input losing focus, which would otherwise re-hide the
            // value on blur the instant the toggle is clicked.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setRevealed((v) => !v)}
          >
            <EyeIcon open={revealed} />
          </button>
        </div>

        {error ? (
          <span className="field__error" id={`${inputId}-error`} role="alert">
            {error}
          </span>
        ) : (
          hint
        )}
      </div>
    );
  },
);
