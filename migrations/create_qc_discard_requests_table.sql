-- Migration: Create qc_discard_requests table
-- This table stores discard requests from Sell & Recheck entries

CREATE TABLE IF NOT EXISTS qc_discard_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shipment_id INT NULL COMMENT 'Corresponding shipment ID from qc_lots',
  sell_recheck_id INT NOT NULL COMMENT 'ID from qc_sell_recheck_entries table',
  discard_quantity DECIMAL(15, 3) NOT NULL COMMENT 'Quantity to discard',
  discard_quantity_weight DECIMAL(15, 3) NULL COMMENT 'Weight quantity to discard (if applicable)',
  remark TEXT NULL COMMENT 'Remarks/notes for the discard request',
  applied_by INT NULL COMMENT 'User ID who applied/created the discard request',
  status_id INT NULL COMMENT 'Status ID (e.g., 8 for Submitted for Approval)',
  is_approved TINYINT(1) DEFAULT 0 COMMENT 'Whether the discard request has been approved',
  approved_by INT NULL COMMENT 'User ID who approved the discard request',
  approved_at DATETIME NULL COMMENT 'Timestamp when the discard request was approved',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by INT NULL COMMENT 'User ID who created the record',
  updated_by INT NULL COMMENT 'User ID who last updated the record',
  INDEX idx_shipment_id (shipment_id),
  INDEX idx_sell_recheck_id (sell_recheck_id),
  INDEX idx_status_id (status_id),
  INDEX idx_applied_by (applied_by),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (sell_recheck_id) REFERENCES qc_sell_recheck_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (shipment_id) REFERENCES shipment(id) ON DELETE SET NULL,
  FOREIGN KEY (applied_by) REFERENCES `user`(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES `user`(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES `user`(id) ON DELETE SET NULL,
  FOREIGN KEY (approved_by) REFERENCES `user`(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Discard requests from Sell & Recheck entries';

