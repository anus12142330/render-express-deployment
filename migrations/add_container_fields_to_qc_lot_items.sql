-- Add container_id and container_no columns to qc_lot_items table
ALTER TABLE `qc_lot_items` 
ADD COLUMN `container_id` INT NULL COMMENT 'Reference to shipment_container.id' AFTER `qc_lot_id`,
ADD COLUMN `container_no` VARCHAR(100) NULL COMMENT 'Container number for this lot item' AFTER `container_id`;

-- Add index for container_id for better query performance
ALTER TABLE `qc_lot_items` 
ADD INDEX `idx_container_id` (`container_id`);
