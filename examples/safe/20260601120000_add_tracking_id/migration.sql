-- expand/contract; each step is its own migration

-- 1. add column nullable
SET lock_timeout = '5s';
ALTER TABLE "orders" ADD COLUMN "tracking_id" UUID;

-- 2. default for new rows
SET lock_timeout = '5s';
ALTER TABLE "orders" ALTER COLUMN "tracking_id" SET DEFAULT gen_random_uuid();

-- 3. backfill in batches (repeat until 0 rows)
UPDATE "orders" SET "tracking_id" = gen_random_uuid()
WHERE "tracking_id" IS NULL
  AND "id" IN (SELECT "id" FROM "orders" WHERE "tracking_id" IS NULL LIMIT 10000);

-- 4. enforce NOT NULL via validated CHECK (PG12+, skips the scan)
SET lock_timeout = '5s';
ALTER TABLE "orders" ADD CONSTRAINT "orders_tracking_id_nn"
  CHECK ("tracking_id" IS NOT NULL) NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_tracking_id_nn";
ALTER TABLE "orders" ALTER COLUMN "tracking_id" SET NOT NULL;
ALTER TABLE "orders" DROP CONSTRAINT "orders_tracking_id_nn";
