# PhonePilot agent Worker

This standalone Cloudflare Worker recommends one next action for the personal Android app PhonePilot. It does not execute Android actions, expose a CORS API, or accept any endpoint other than `POST /v1/next-action`.

## Security and privacy contract

- Set `PHONEPILOT_DEVICE_TOKEN` and `OPENAI_API_KEY` only as Worker secrets. The bearer is provisioned after APK installation and must never be embedded in the APK.
- Android must locally scan the task, every `history.action` and `history.result`, and every UI-tree label *before* it constructs a request. OTPs, passwords, CVVs, cards, account numbers, UPI/payment IDs, and credentials must block locally: no request is sent and Android logs only `sensitive_content_blocked`. Never send screenshots.
- The Worker does not log request data, response data, model output, headers, errors, or tokens. It sends the provider request with `store: false`.
- Android is the final policy authority. The request schema intentionally has no local package allowlist, so the Worker cannot enforce it; Android must reject an `open_app` outside its local allowlist.
- Android retains a session-local UI map and fingerprints. Before every index action, capture a fresh tree and compare package, role, bounds, clickable/editable state, and a normalized non-sensitive-label SHA-256. Discard stale, missing, or changed elements; never use coordinates or guess an element.
- Android may type into ordinary non-sensitive fields. It rejects password, OTP, payment, banking, login, and credential fields locally. A send-like tap may proceed only when the original task clearly says `send`, `message`, or `text` a named recipient and that recipient is visible in the current UI; all other consequential actions remain confirmation-gated.
- The app keeps at most 50 in-memory, metadata-only audit records (timestamp, action kind, package, index, outcome, and reason code). The audit never stores a task, UI label, typed text, token, or screenshot.

## Limits

After authentication and complete input/privacy validation, the Worker hashes the bearer token with SHA-256 (lowercase hexadecimal). The hash alone keys a Cloudflare Rate Limiting binding (30 requests per 60 seconds). This limit is best effort and eventually consistent. Only then does a SQLite-backed Durable Object reserve the strict 300-per-UTC-day allowance. A successful reservation is consumed even if OpenAI subsequently fails. The Durable Object stores only a UTC bucket string and integer count.

## Request and response

Request JSON fields are exactly `task`, `activePackage`, `serializedUiTree`, and `history`. See the source for strict length/type validation. Successful responses are exactly:

```json
{"action":{"type":"tap_element","index":2}}
```

Failures are exactly:

```json
{"error":{"code":"invalid_request","message":"Invalid request"}}
```

## Setup (do not put real values in this repository)

```sh
npx wrangler --version
npx wrangler login
npx wrangler secret put PHONEPILOT_DEVICE_TOKEN # paste a generated device token when prompted
npx wrangler secret put OPENAI_API_KEY # paste the OpenAI API key when prompted
npx wrangler deploy
```

After deployment, the Worker URL follows `https://phonepilot-agent.<your-subdomain>.workers.dev`.

```sh
curl -X POST 'https://phonepilot-agent.<your-subdomain>.workers.dev/v1/next-action' \
  -H 'Authorization: Bearer <PHONEPILOT_DEVICE_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"task":"Open calendar","activePackage":"com.example.launcher","serializedUiTree":"Button Calendar","history":[]}'
```

Run checks locally with:

```sh
npm test
npx wrangler --version
```
