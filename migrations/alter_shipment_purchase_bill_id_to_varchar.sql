-- Migration: Alter shipment.purchase_bill_id column from INT to VARCHAR to support comma-separated IDs
-- This allows storing multiple purchase bill IDs as comma-separated values (e.g., "1,2,3")

-- Alter the column from INT to VARCHAR(255) to store comma-separated IDs
-- Convert existing integer values to string format
ALTER TABLE `shipment` 
MODIFY COLUMN `purchase_bill_id` VARCHAR(255) NULL COMMENT 'Comma-separated purchase bill IDs (e.g., "1,2,3")';

-- Note: Existing foreign key constraints on purchase_bill_id may need to be dropped first if they exist
-- The following command will attempt to drop the foreign key if it exists (adjust constraint name as needed)
-- ALTER TABLE `shipment` DROP FOREIGN KEY `fk_shipment_purchase_bill`; -- Uncomment and adjust if needed

-- Since we're storing comma-separated values, we can no longer use a foreign key constraint
-- The application layer should validate that the IDs exist in the ap_bills table
