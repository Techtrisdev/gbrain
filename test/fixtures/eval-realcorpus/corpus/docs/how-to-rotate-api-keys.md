# How to rotate API keys safely

Rotate long-lived API keys on a 90-day cadence, or immediately after a suspected leak.
The goal is zero downtime: create the new key, roll it out, then revoke the old one.

1. In the API dashboard, generate a second key for the same service account. Both keys
   are now valid simultaneously.
2. Update the secret in the deployment environment (the secrets manager, not source
   control) and redeploy so running instances pick up the new key.
3. Watch request logs until you confirm no service is still presenting the old key.
4. Revoke the old key from the dashboard. Keep an audit note of who rotated it and when.

Never paste a key into a ticket, a chat message, or a commit. If a key is ever printed
to a build log, treat it as compromised and rotate immediately.
