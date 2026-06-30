# Decision: standardize on Postgres

We will standardize new services on PostgreSQL rather than maintaining a mix of MySQL
and Postgres.

Context: running two relational engines doubled the operational surface — two failover
runbooks, two backup pipelines, two sets of tuning knowledge. Most teams already
defaulted to Postgres for its JSONB support and richer indexing.

Decision: Postgres is the default relational store. Existing MySQL services keep running
but new ones start on Postgres, and migrations are scheduled opportunistically.

Consequences: one failover runbook, one backup story, and one pool of expertise. The
cost is a finite migration effort for the remaining MySQL services.
