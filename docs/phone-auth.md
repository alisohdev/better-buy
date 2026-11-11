# Phone authentication

The API uses phone/password authentication. Email and Google routes are removed. `user.id` and application ownership keys remain unchanged. Back up SQLite, then run `pnpm api:migrate` before starting the new API. Migration `0021_phone_auth.sql` adds unique canonical phones, password hashes, verification timestamps, OTP challenges, single-use tickets, and persistent abuse limits. It revokes existing sessions and clears obsolete authentication secrets. It preserves fixture users, legacy identity metadata, account rows, locations, scans, settings, carts, and wishlists. Legacy identity labels are preserved in an inert `legacy_identity` metadata column; live email verification and obsolete account credential/token columns are removed. They are never used to authenticate or authorize.

## Local setup

Use a loopback origin consistently (prefer `127.0.0.1` for both browser and API):

```env
DEV_MODE=true
SMS_PROVIDER=mock
BETTER_AUTH_URL=http://127.0.0.1:8787
APP_ORIGIN=http://127.0.0.1:3000
CORS_ORIGIN=http://127.0.0.1:3000
BETTER_AUTH_SECRET=<random secret at least 32 characters>
OTP_SECRET=<different random secret at least 32 characters>
BOX_KEY=<existing application encryption key>
```

Run the existing environment loader and `pnpm api:migrate`, then `pnpm dev`. Register a phone through the normal UI. Mock delivery writes the latest code into `.data/mock-sms/989123456789` relative to the API working directory. This ignored local file is the only development code channel; codes never appear in HTTP responses or logs. Treat it as sensitive and delete it after development. The mock adapter is rejected outside explicitly enabled loopback development. The old test-login route and UI have been removed. Development scan scripts now require an existing session cookie via `BETTER_BUY_SESSION_COOKIE`.

## Production SMS

Set `SMS_PROVIDER=iranpayamak` (default), `IRANPAYAMAK_API_KEY`, `IRANPAYAMAK_PATTERN_CODE`, `IRANPAYAMAK_SENDER_LINE`, `OTP_SECRET`, and `OTP_SMS_DOMAIN`. Use HTTPS for `BETTER_AUTH_URL` and the web app, and exact explicit allowed origins. Cookies are host-only, HttpOnly, SameSite=Lax, Secure on HTTPS, and persistent for 30 days. Prefer a same-origin API reverse proxy; separate unrelated sites are not supported by the Lax cookie policy. Never put SMS secrets in `NEXT_PUBLIC_*` variables.

IranPayamak uses `POST https://api.iranpayamak.com/ws/v1/sms/pattern`, an `Api-Key` header, and JSON `code`, `attributes`, `recipient`, `line_number`, `number_format`. The adapter sends attributes `code`, `code2` (same ASCII OTP), and `domain`; approve a pattern using exactly these variable names.

MeliPayamak is separate: choose `SMS_PROVIDER=melipayamak`, `MELIPAYAMAK_USERNAME`, `MELIPAYAMAK_API_KEY` (or `MELIPAYAMAK_PASSWORD`), and `MELIPAYAMAK_PATTERN_ID`. This adapter uses the documented REST `BaseServiceNumber` endpoint with form-encoded credentials, template ID and two semicolon-separated OTP arguments. It uses the provider shared service line, so no sender-line variable applies. The domain must be literal text in that approved template. Require a successful provider status and a message receipt longer than 15 digits.

Approve this exact rendered text, with no appended signature or other text after the final line:

```text
کد تأیید بهتر بخر: 123456

@better-buy.ir #123456
```

Use the actual authentication page hostname in `OTP_SMS_DOMAIN`, including `www` when applicable. Ask provider support to confirm repeated OTP variables, ASCII digits, newline preservation and no suffix. Only after inspecting a real delivered SMS set `SMS_TEMPLATE_WEBOTP_APPROVED=true`. Startup rejects production SMS configuration without that explicit acknowledgement. No real SMS is sent by tests. Requests have timeouts and no automatic retries. Delivery errors invalidate the challenge and return the same public start response to avoid leaking account existence; use provider panel delivery reports to diagnose failures.

Official references: [IranPayamak pattern API](https://docs.iranpayamak.com/send-pattern-based-sms-13925177e0), [MeliPayamak template API](https://www.melipayamak.com/api/sendbybasenumber2/), [Chrome WebOTP](https://developer.chrome.com/docs/identity/web-apis/web-otp), [Nexus component](https://www.nexus-ui.com/components/otp-input).

## Security and operations

Passwords use Argon2id (defaults: 64 MiB, three iterations, two threads), fresh 16-byte salts, 12-character minimum, and up to 1024 UTF-8 bytes. `ARGON2_TIME` (2–6), `ARGON2_MEMORY_KIB` (19456–262144), and `ARGON2_THREADS` (1–4) tune new hashes; parameters are stored with each hash. Invalid settings use safe defaults.

OTPs expire after three minutes, allow five attempts, and are stored as keyed HMACs bound to their challenge IDs. Tickets expire after five minutes, are purpose-bound, hashed at rest, and consumed transactionally. Resends invalidate earlier challenges and tickets. SMS limits are 10 starts per phone per rolling day, a 60-second cooldown, and 30 starts per source IP per day. Auth endpoints also enforce 60 requests per IP per 15 minutes; password login has a per-phone limit of 15 per 15 minutes. Counters persist across restarts. IP limits use the socket address and do not trust client forwarding headers: behind a proxy all clients share the proxy limit. Configure an upstream trusted-client rate limiter and account for this intentionally conservative application limit before a larger launch. No CAPTCHA or distributed proxy-IP attribution is implemented.

State-changing API requests require an allowlisted Origin or Referer. No wildcard credentialed CORS is allowed. Session reads use no-store headers and server expiry checks. Password reset revokes every session and returns to password login. Auth state is never stored in localStorage. Hourly and post-request cleanup removes expired authentication records while retaining daily-limit history.

`ADMIN_PHONES` accepts normalized Iranian phones. **All admin endpoints remain denied**, including allowlisted verified users, until a separately audited TOTP/passkey step-up is implemented. There is no first-user administrator and no SMS-based admin bypass.

## Device acceptance testing

1. Use a staging HTTPS hostname matching the template. Configure approved credentials with a strict SMS spending cap; this is a deliberate manual paid test.
2. On Android Chrome, open registration and request a code. Confirm the origin-bound SMS prompt appears, accept it, and verify that the backend confirms it once. Repeat for password recovery.
3. On iOS Safari, focus the OTP field and select the SMS code suggestion. Confirm manual typing and pasting work when no suggestion appears.
4. Reject the Android permission prompt; navigate away while waiting; edit the phone; resend after 60 seconds. Confirm old codes fail and no stale listener changes a newer challenge.
5. Test Persian/Arabic digits, incorrect and expired codes, airplane mode and server errors. Repeat in dark mode, at 320px width and with reduced motion enabled.
6. Register, create a location and scan, logout/login, and confirm records remain owned by that user. Reset the password in another browser and verify the old session stops working.

Automated browser tests simulate WebOTP, not actual modem/SMS delivery. Carrier delivery, template modification, Android prompts and iOS suggestions require these real-device tests.

Login UX: an unknown phone returns a dedicated not-registered message and the UI offers registration with the entered phone retained. This intentionally reveals account existence at password login; phone and IP rate limits still apply. Recovery start responses remain indistinguishable.
