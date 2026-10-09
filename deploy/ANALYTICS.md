# Yandex Metrica — 21 September 2026

Counter: 112866346, «СТАРТ — spotsup.ru», owner sacha2121. Website-only counter, separate from existing Yandex Business counters. Owner explicitly approved acceptance of Metrica terms before creation. Moscow timezone, RUB; restricted to spotsup.ru, subdomains excluded.

Report: https://metrika.yandex.ru/overview?id=112866346

Six exact-match event goals configured in the account:
- booking_open — Открытие формы бронирования
- booking_sent — Заявка успешно отправлена (favorite)
- discount_request — Запрос скидки 100 рублей
- phone_click — Нажатие на телефон
- telegram_click — Переход в Telegram
- route_view — Просмотр маршрутов

Success goals fire only after a successful API result, not on submit clicks. Booking duplicate=true and promo duplicate=true do not generate another success goal. Promo API now returns its pre-existing deduplication outcome without changing delivery logic. A discount request is not evidence of SMS delivery or redemption. Contact clicks are not evidence of an actual call/conversation. Confirmations, rental payments and revenue remain in the station admin; offline conversions have not been connected to Metrica.

Installation: METRIKA_COUNTER_ID in /etc/start-site.env; server/analytics.mjs inserts /analytics.js into published homepage/service-page HTML. Preview and admin never include it; browser additionally restricts execution to spotsup.ru homepage and /prokat/{id}/. No counter in game. Webvisor, form recording, click map, automatic link tracking, automatic goals, ecommerce and tag manager disabled. No name, telephone, SMS text, booking ID or other form fields passed as event parameters. Page URL drops query/hash; referrer is reduced to origin. Thus arbitrary UTM query parameters are not forwarded by this integration. Search/referral/direct sources remain available, but campaign-level attribution needs separate implementation if advertising is added.

Tests: node --test server/*.test.mjs — 53 passed locally and on VPS. Analytics tests use a fake browser environment and verify privacy restrictions, exact goals, blocked admin/local routes and field exclusion. Existing booking/SMS tests also pass. Browser check on live https://spotsup.ru/?_ym_debug=2 logged PageView for counter 112866346 and Reach goal booking_open. No paid SMS or fake production booking was submitted for this check. Reporting may lag behind debug events.

Official diagnostics: https://yandex.ru/support/metrica/ru/general/check-counter.html . Open the public site with ?_ym_debug=2, open the booking form without submitting, and inspect the Metrica debug panel/console. Return with ?_ym_debug=0 to close debugging.

Files: server/analytics.mjs, server/analytics.test.mjs, server/content.mjs, server/services.mjs, server/sms.mjs; dist/analytics.js, dist/app.js, dist/telegram-booking.js, dist/discount.js; deploy/publish-analytics.py.

Rollback archive: /opt/start-site-before-analytics-20260921T120935Z.tar.gz. Database snapshot: /var/backups/start-site/before-analytics-20260921T120935Z.sqlite. Existing data, homepage file, game, camera and SMS credentials/settings were preserved. To disable tracking, remove METRIKA_COUNTER_ID from the private environment and restart start-site; do not restore an old database over real bookings.
