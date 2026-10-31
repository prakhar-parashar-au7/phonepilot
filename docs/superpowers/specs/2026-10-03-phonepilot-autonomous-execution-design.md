# PhonePilot Autonomous Execution Design

## Goal

Make PhonePilot useful for multi-step phone tasks without routine confirmation prompts. It may navigate, type, and send a message when the spoken task explicitly identifies both the recipient and the send intent.

## Non-negotiable boundaries

- Never send task, history, or UI text containing passwords, OTPs, payment data, account numbers, card data, or credentials to the Worker.
- Never type into password, OTP, payment, banking, or login fields.
- Never execute a tap, type, or send if the current UI does not match the locally retained snapshot that informed the Worker recommendation.
- The Android package allowlist remains authoritative. A Worker `open_app` recommendation outside it is discarded.
- A send is automatic only when the original voice task has explicit send intent and an explicit recipient. Ambiguous messages stop with `ask_user`.

## Request session and fingerprinting

For every Worker request, Android builds an indexed local map of actionable UI elements. Each entry contains a privacy-safe fingerprint: active package, role, bounds, clickable/editable state, and a one-way hash of any non-sensitive label. Fingerprints never leave the phone.

Android retains this map in a request session keyed to the single Worker decision. Before it executes `tap_element` or `type_text`, it captures a fresh accessibility snapshot and requires the element at that index to have the exact retained fingerprint. A mismatch, missing index, or package change discards the recommendation and returns a safe stale-action result. The next loop may obtain a new decision from a fresh snapshot.

## Autonomous typing and sending

`type_text` is admitted by the Worker schema and then evaluated locally. Android checks the retained fingerprint, verifies the element is editable, rejects a sensitive field/label, and applies the text. It does not rely on the Worker to determine local field safety.

After typing, Android captures a new snapshot. A tap on a send-like button is allowed only when all of these conditions hold:

1. the original voice task explicitly includes a send verb;
2. it names a recipient or a uniquely matched current conversation;
3. the current app is in the local package allowlist;
4. the current send button fingerprint matches a locally captured snapshot; and
5. the message does not match the sensitive-content policy.

Otherwise a send-like action is converted to `ask_user` locally. Existing hard stops for order, payment, deletion, permission changes, sharing, and calls remain in force unless separately designed later.

## Privacy-safe audit trail

Android retains a bounded in-memory action trace for the active task. It records timestamps, action kind, allowed/rejected/executed outcome, foreground package, index, and reason code. It does not store raw task text, UI labels, typed text, tokens, or Worker/provider responses. The overlay can show concise current-step status; debug export is not part of this change.

## Worker contract

The Worker continues to return only one validated action. Its schema allows `type_text`; Android remains the enforcement point for field safety, recipient/send intent, package allowlisting, and stale UI checks. System instructions continue to treat task, UI tree, and history as untrusted data.

## Testing

- Android unit tests cover matching and stale fingerprints, package mismatch, and an unallowlisted `open_app` recommendation.
- Tests verify sensitive task/history/tree values never enter the HTTP request body.
- Tests cover automatic search typing, rejection of sensitive fields, automatic send with explicit recipient/send task, and rejection of ambiguous send intent.
- Worker tests retain strict action-schema and malformed-provider-output coverage.
