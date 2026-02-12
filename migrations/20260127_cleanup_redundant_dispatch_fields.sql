-- Cleanup redundant dispatch columns from sales_orders header
-- These are now tracked in sales_order_dispatches for multi-entry shipments.
-- Created: 2026-01-27

ALTER TABLE `sales_orders` 
DROP COLUMN IF EXISTS `vehicle_no`,
DROP COLUMN IF EXISTS `driver_name`,
DROP COLUMN IF EXISTS `dispatched_by`,
DROP COLUMN IF EXISTS `dispatched_at`;
