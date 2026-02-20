-- Add comments column to sales_order_dispatches (used by dispatch API)
-- Created: 2026-02-20

ALTER TABLE `sales_order_dispatches`
ADD COLUMN `comments` TEXT NULL AFTER `driver_name`;
