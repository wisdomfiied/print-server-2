# Print server — Arun's Coral Springs + Sunrise/Lauderhill
Same system as the Boca server. Store keys: `aruns-coral-springs`, `aruns-sunrise`.
Edit `stores.json` to set each printer's MAC (lowercase, colons). Railway vars: ADMIN_KEY, QUEUE_FILE=/data/queue.json, TZ_NAME, SECRET_ARUNS_CORAL_SPRINGS, SECRET_ARUNS_SUNRISE.
Webhooks: /webhooks/<store-key>/orders-create   Printer URL: /print (polling 5)
Admin: /admin/status, /admin/last?store=, /admin/test?store=, /admin/clear?store=, /admin/preview?store=
