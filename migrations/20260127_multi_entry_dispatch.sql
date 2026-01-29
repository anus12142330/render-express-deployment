-- Migration to support Multi-Entry Dispatch (Partial Shipments)
-- Created: 2026-01-27

-- 1. Drop the old single-entry dispatch table if it exists
DROP TABLE IF EXISTS `sales_order_dispatch`;

-- 2. Create the multi-entry dispatch header table
CREATE TABLE IF NOT EXISTS `sales_order_dispatches` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `client_id` INT(11) NOT NULL,
  `sales_order_id` INT(11) NOT NULL,
  `vehicle_no` VARCHAR(100) DEFAULT NULL,
  `driver_name` VARCHAR(100) DEFAULT NULL,
  `dispatched_by` INT(11) DEFAULT NULL,
  `dispatched_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_so_dispatches` (`client_id`, `sales_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. Create the itemized dispatch tracking table
CREATE TABLE IF NOT EXISTS `sales_order_dispatch_items` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `client_id` INT(11) NOT NULL,
  `dispatch_id` INT(11) NOT NULL,
  `sales_order_item_id` INT(11) NOT NULL,
  `quantity` DECIMAL(15, 4) NOT NULL DEFAULT 0.0000,
  PRIMARY KEY (`id`),
  INDEX `idx_client_dispatch_items` (`client_id`, `dispatch_id`),
  CONSTRAINT `fk_dispatch_items_parent` FOREIGN KEY (`dispatch_id`) REFERENCES `sales_order_dispatches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4. Update attachments table to link to specific dispatch records
ALTER TABLE `sales_order_attachments` 
ADD COLUMN IF NOT EXISTS `dispatch_id` INT(11) NULL AFTER `sales_order_id`,
ADD INDEX IF NOT EXISTS `idx_attach_dispatch` (`dispatch_id`);

-- 5. Ensure sales_order_items has the aggregate tracking columns
ALTER TABLE `sales_order_items` 
MODIFY COLUMN `quantity` DECIMAL(15, 4) NOT NULL DEFAULT 0.0000,
ADD COLUMN IF NOT EXISTS `ordered_quantity` DECIMAL(15, 4) DEFAULT 0.0000 AFTER `quantity`,
ADD COLUMN IF NOT EXISTS `dispatched_quantity` DECIMAL(15, 4) DEFAULT 0.0000 AFTER `ordered_quantity`;

-- 6. Backfill ordered_quantity for existing items
UPDATE `sales_order_items` SET `ordered_quantity` = `quantity` WHERE `ordered_quantity` = 0 AND `quantity` > 0;
