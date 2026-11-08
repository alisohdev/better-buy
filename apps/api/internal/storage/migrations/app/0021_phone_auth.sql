-- Preserve IDs, legacy fixture identities, and all application data.
ALTER TABLE "user" ADD COLUMN phone TEXT;
ALTER TABLE "user" ADD COLUMN phoneVerified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user" ADD COLUMN phone_verified_at TEXT;
ALTER TABLE "user" ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX user_phone_unique ON "user"(phone) WHERE phone IS NOT NULL;
CREATE TABLE otp_challenges(id TEXT PRIMARY KEY,phone TEXT NOT NULL,purpose TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX otp_phone_created ON otp_challenges(phone,created);
CREATE TABLE auth_tickets(hash TEXT PRIMARY KEY,phone TEXT NOT NULL,purpose TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE auth_limits(key TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(key,window));
DELETE FROM session;
DELETE FROM verification;
UPDATE account SET password=NULL,accessToken=NULL,refreshToken=NULL,idToken=NULL;
-- Preserve fixture identity labels as inert metadata, removing live email fields.
ALTER TABLE "user" RENAME COLUMN email TO legacy_identity;
ALTER TABLE "user" DROP COLUMN emailVerified;
ALTER TABLE account DROP COLUMN accessToken;
ALTER TABLE account DROP COLUMN refreshToken;
ALTER TABLE account DROP COLUMN accessTokenExpiresAt;
ALTER TABLE account DROP COLUMN refreshTokenExpiresAt;
ALTER TABLE account DROP COLUMN scope;
ALTER TABLE account DROP COLUMN idToken;
ALTER TABLE account DROP COLUMN password;
