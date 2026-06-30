# Runbook: flushing the Redis cache safely

Flush cache keys when stale data is being served, without taking down the whole cache.

1. Identify the affected key prefix from the incident report — never `FLUSHALL` in
   production unless every key is known to be safe to drop.
2. Use `SCAN` with a `MATCH prefix:*` pattern to enumerate the keys, then delete them in
   small batches so you don't block the Redis event loop.
3. Watch the cache hit-rate and database load while keys repopulate; a sudden flush
   shifts traffic onto the database.
4. If load spikes, warm the cache by replaying the most common queries before reopening
   traffic.
