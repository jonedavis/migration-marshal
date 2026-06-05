-- add a tracking id to orders
ALTER TABLE 
    "orders" ADD COLUMN "tracking_id" UUID 
    NOT NULL 
    DEFAULT gen_random_uuid();
