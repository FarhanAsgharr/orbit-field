-- Magic-link sign-in reuses the OTP table so that consuming a link is a
-- database write. A bare signed token cannot be invalidated once issued, which
-- would leave a working credential in the recipient's inbox indefinitely.
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'MAGIC_LINK';
