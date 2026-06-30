# Runbook: on-call incident response

The first responder's job is to stabilize, communicate, and hand off — not to find the
root cause in the moment.

1. Acknowledge the page within five minutes. Open an incident channel and post the
   alert, the suspected blast radius, and a severity guess.
2. Mitigate first: roll back the most recent deploy, fail over, or disable the offending
   feature flag. Restoring service beats diagnosing.
3. Keep a running timeline in the channel — every action with a timestamp.
4. If the incident lasts more than 30 minutes or customer-facing data is at risk,
   escalate to the secondary on-call and notify the incident commander.
5. After recovery, schedule a blameless postmortem within two business days.
