# Runbook: Postgres failover

Follow this when the primary Postgres node is unhealthy and a replica must be promoted.
Page the database on-call before starting and announce in the incident channel.

1. Confirm the primary is actually down (not a network blip) by checking the health
   endpoint and replication lag dashboard.
2. Pick the replica with the lowest lag. Promote it with `pg_ctl promote` (or the managed
   provider's "promote replica" button).
3. Update the database connection string / DNS record to point at the newly promoted
   primary, then restart application instances so connection pools reconnect.
4. Re-point the remaining replicas at the new primary and verify replication resumes.
5. After recovery, write a short postmortem and capture why the original primary failed.
