# Integration: configure Slack notifications

Post build, deploy, and alert messages into a Slack channel using an incoming webhook.

1. Create a Slack app, enable "Incoming Webhooks", and add a webhook for the target
   channel. Slack returns a webhook URL — treat it like a secret.
2. Store the URL in the secrets manager as `SLACK_WEBHOOK_URL`; do not commit it.
3. To send a message, POST a JSON body `{ "text": "..." }` to the webhook URL. Use Block
   Kit blocks for richer formatting with fields and buttons.
4. Rate-limit your notifications — Slack throttles roughly one message per second per
   webhook, and noisy channels get muted by humans anyway.
