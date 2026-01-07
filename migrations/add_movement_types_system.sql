-- Create movement_types master table
CREATE TABLE IF NOT EXISTS movement_types (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  affects_stock_on_hand TINYINT(1) DEFAULT 1 COMMENT '1=affects stock, 0=does not affect',
  stock_direction ENUM('IN', 'OUT', 'NEUTRAL') DEFAULT 'NEUTRAL' COMMENT 'How it affects stock calculation',
  is_active TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Insert standard movement types
INSERT INTO movement_types (id, code, name, description, affects_stock_on_hand, stock_direction, is_active, sort_order) VALUES
(1, 'REGULAR_IN', 'Regular Stock IN', 'Regular stock received and available for sale', 1, 'IN', 1, 1),
(2, 'REGULAR_OUT', 'Regular Stock OUT', 'Regular stock sold or issued', 1, 'OUT', 1, 2),
(3, 'IN_TRANSIT', 'IN TRANSIT', 'Stock received but in transit (not yet available)', 0, 'NEUTRAL', 1, 3),
(4, 'TRANSIT_OUT', 'TRANSIT OUT', 'Stock going out in transit (shipment)', 0, 'NEUTRAL', 1, 4),
(5, 'DISCARD', 'DISCARD', 'Stock discarded/rejected (waste)', 1, 'OUT', 1, 5)
ON DUPLICATE KEY UPDATE name=VALUES(name);

-- Update inventory_transactions to use movement_types table
-- Add movement_type_id column (ignore error if already exists)
ALTER TABLE inventory_transactions 
ADD COLUMN movement_type_id INT DEFAULT 1 COMMENT 'References movement_types.id';

-- Update existing NULL values to default (REGULAR_IN)
UPDATE inventory_transactions SET movement_type_id = 1 WHERE movement_type_id IS NULL;

-- Add foreign key constraint (ignore error if already exists)
ALTER TABLE inventory_transactions 
ADD CONSTRAINT fk_inv_txn_movement_type FOREIGN KEY (movement_type_id) REFERENCES movement_types(id) ON DELETE RESTRICT;

-- Add index for better query performance
CREATE INDEX idx_inventory_transactions_movement_type ON inventory_transactions(movement_type_id);
CREATE INDEX idx_inventory_transactions_source ON inventory_transactions(source_type, source_id);

-- Add is_completed and completed_at to qc_sell_recheck_entries (if not already added)
ALTER TABLE qc_sell_recheck_entries
ADD COLUMN IF NOT EXISTS is_completed TINYINT(1) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP NULL;

