-- NOTE: This migration is superseded by add_movement_types_system.sql
-- Use add_movement_types_system.sql instead which creates the movement_types table
-- and properly links inventory_transactions to it

-- Add is_completed and completed_at to qc_sell_recheck_entries
ALTER TABLE qc_sell_recheck_entries
ADD COLUMN is_completed TINYINT(1) NOT NULL DEFAULT 0,
ADD COLUMN completed_at TIMESTAMP NULL;

-- Add index for better query performance
CREATE INDEX idx_inventory_transactions_movement_type ON inventory_transactions(movement_type_id);
CREATE INDEX idx_inventory_transactions_source ON inventory_transactions(source_type, source_id);

