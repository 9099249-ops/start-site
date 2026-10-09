# SMS Aero connection — 21 September 2026

Owner selected SMS delivery for the АЭЛИТА promotion: 100 RUB discount on any water activity.

The owner saved an existing key with deploy/setup-smsaero.ps1. Windows DPAPI storage is outside the repository at ~/.ssh/start-smsaero.secret.json. deploy/connect-smsaero.py takes decrypted credentials on stdin and passes them through SSH stdin; neither credentials nor Authorization headers are printed or placed in command arguments.

Verified from the production VPS using HTTPS Basic Auth against https://gate.smsaero.ru/v2/: auth succeeded; balance returned 50 RUB; sign/list returned totalCount 0. No SMS was sent, no balance was spent, and no paid sender was ordered.

SMSAERO_EMAIL and SMSAERO_API_KEY were saved atomically in /etc/start-site.env, mode 0600. Existing settings were preserved. SMS_ENABLED=false. The service was not restarted; the current application does not yet implement the SMS promotion flow. Saving credentials alone does not activate delivery.

No custom sender is available. Official SMS Aero SDKs document the shared sign `SMS Aero`; actual acceptance and delivery for this account have not been tested. The cabinet reports API moderation enabled, with approximately five-minute moderation. Do not promise immediate arrival.

## Implemented

`server/sms.mjs` provides the shared SmsService, SQLite queue, clients, promo requests, settings, rescheduling and authenticated HTTP endpoints. The existing SQLite database is extended; it is never replaced. Existing inquiries and rentals feed one clients table by normalized Russian phone (+7 / 8 / 10 digits). No separate SMS-only customer database. Booking records retain their original client snapshot.

The worker runs on application startup and every 30 seconds. Confirmation, rescheduling and promo requests also wake it immediately. There is no 24-hour notification. Only confirmed bookings with a future appointment qualify; season-pass purchases without an appointment do not. Issued, completed, cancelled, deleted and expired bookings cannot send a queued reminder.

Dates are interpreted explicitly as Moscow UTC+03:00 and stored as epoch milliseconds. A normal reminder is due one hour before the appointment, or immediately if confirmation happens within the hour. A reschedule creates a new generation and cancels the previous unsent generation. When the old notification was already accepted (or outcome is unknown), the new generation sends an explicit changed-time notification immediately. Its successful submission replaces the one-hour reminder for that generation; it does not also send another message one hour before that same new appointment.

Queue claims and daily quota reservations use BEGIN IMMEDIATE and conditional updates. Restarted `sending` jobs become `unknown` after two minutes. Structured provider rejections retry up to five total attempts with increasing delay, only while the booking remains future and active. Network timeouts, unparseable replies and ambiguous server errors are NOT blindly retried: SMS Aero's documented send endpoint has no client idempotency key. Inspect its cabinet before any manual recovery; there is intentionally no unsafe retry button. Already transmitted SMS cannot be recalled when a booking changes in flight. The current booking is checked immediately before claiming the job.

`accepted` means SMS Aero accepted the request, not delivery to a handset. Delivery is polled using sms/status. Undelivered/rejected accepted messages are marked failed, without a second billable send. Unknown outcomes remain visible for owner review. No provider response bodies, authorization headers or keys are logged.

## Owner settings

Open https://spotsup.ru/admin/#sms-settings under the administrator account. Staff can view jobs/clients, redeem promos and reschedule bookings but cannot change SMS settings.

- YANDEX_NAVIGATOR_URL: one setting in sms_settings JSON, shared by promo and reminder templates.
- STATION_PHONE: uses the existing **published** CMS contact phone (`site_content.published.phone`), shown read-only in SMS settings. Change it in Content and SEO → Contacts, then publish.
- BOOKING_LATE_CANCEL_MINUTES: editable integer, default 15. The SMS explicitly warns about cancellation. This feature does not itself automatically cancel the booking after that interval.
- Shared sender, switches, daily message-count limit, promo code and discount amount are editable here. The limit counts logical sends, not billable segments/rubles. Default 10 per Moscow calendar day; provider balance is a separate constraint.
- SMS_ENABLED in /etc/start-site.env is the server transport gate; credentials stay there, mode 0600. The owner-visible enabled switch starts OFF. Public discount form is hidden while sending is disabled.

The homepage includes a discount form, explicit delivery-data consent and a separate unchecked marketing consent. Name/phone, consent, campaign source and promo are saved before provider contact. One issuance per client/code prevents duplicate promo SMS. Staff records redemption in Clients; it does not silently change rental payments. No promotional broadcast is implemented. The public form has durable per-IP and per-phone limits (3 requests/hour), honeypot and Origin checks.

## Testing without charges

From the project directory run `node --test server/*.test.mjs` for automated tests. Run `node server/sms-demo.mjs` for a fully isolated manual environment, then open http://127.0.0.1:14876/. All outbound SMS and Telegram requests in that process are mocked; it uses a new database in the Windows temporary folder, not production data or keys. Admin: http://127.0.0.1:14876/admin/ ; login `admin`, password `demo-admin-123456` (demo only). Submit a discount request, inspect Clients and the SMS journal, create/confirm a future booking, move or cancel it. The worker marks mocked messages accepted/delivered. Stop the demo with Ctrl+C. Never use this mock process as the production service.

Tests cover all 15 requested reminder cases, ambiguity/crash recovery, promo deduplication and shared settings, daily limits, access roles, stale settings, Origin/consent checks, and existing booking/CMS/rental functionality. Live SMS delivery still requires a separately authorized real test; no paid SMS was sent during development. Do not assume approval to top up, purchase a sender, contact support, or send campaigns.

Official API documentation: https://smsaero.ru/integration/documentation/api/
Official SDK shared sender example: https://github.com/smsaero/smsaero_php

## Deployment verification

Installed 21 September 2026 at 10:50 UTC. All 42 tests passed locally and on the VPS. Public HTTPS homepage, admin, new scripts, game, and booking-config returned 200; booking remains enabled. discount-config reports enabled=false and amount=100. Verified actual SMS Aero balance access from the production Node transport: 2550 RUB, no send invoked. Owner switch remains off; shared sender acceptance and handset delivery are not yet verified.

Rollback code archive: /opt/start-site-before-sms-20260921T105058Z.tar.gz. Database snapshot: /var/backups/start-site/before-sms-20260921T105058Z.sqlite. Existing live homepage was patched only to load discount.js; game and unrelated content preserved.

Changed files: server/sms.mjs, server/server.mjs, server/admin.mjs; dist/discount.js, dist/index.html; dist/admin/sms.js, app.js, index.html, style.css; server/sms.test.mjs, sms.integration.test.mjs, sms-demo.mjs; deploy/SMS.md, setup-smsaero.ps1, connect-smsaero.py, publish-sms.py.

## Authorized live delivery test — 21 September 2026

Owner explicitly approved one labelled test SMS to the station phone with a maximum spend of 100 RUB. At 11:04:46 UTC the production SmsService submitted one Cyrillic segment: «ТЕСТ. СТАРТ: проверка доставки SMS. Это не бронь.» Provider ID 811258887, accepted on FREE SIGN, cost 9.79 RUB. Balance moved from 2550 to 2540.21 RUB. Initial status 8 (moderation), not proof of handset delivery. Durable single-attempt record /var/lib/start-site/sms-owner-test-20260921.json prevents a repeated test submission. Automatic customer sending remains disabled.

Follow-up status check returned status=1, extendStatus=delivery: provider confirms handset delivery. Cost remains 9.79 RUB. No second SMS sent. Automatic customer sending remains disabled pending activation.

Owner explicitly requested activation. Enabled via authenticated admin UI on 21 September 2026: enabled=true, promoEnabled=true, remindersEnabled=true; dailyLimit=10 preserved. UI confirmed settings saved and sending enabled. Public homepage browser verification shows the 100 RUB discount section and Get discount button. No extra test SMS was submitted during activation.
