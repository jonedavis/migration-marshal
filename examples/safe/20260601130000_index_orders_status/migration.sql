SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY "orders_status_idx" ON "orders" ("status");
-- CONCURRENTLY cannot run inside a transaction. Runner must apply it outside BEGIN/COMMIT.
