-- QC Inspection Weight Details
-- Run this migration to add weight details support to inspections (step 3 in form).

-- Table: one row per weight detail entry (Empty box / Fruit weight / Full box + weight + uom + media)
CREATE TABLE IF NOT EXISTS qc_inspection_weight_details (
  id INT AUTO_INCREMENT PRIMARY KEY,
  qc_inspection_id INT NOT NULL,
  weight_type VARCHAR(50) NOT NULL COMMENT 'empty_box | fruit_weight | full_box',
  weight DECIMAL(12,3) NULL,
  uom VARCHAR(50) NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_weight_details_inspection FOREIGN KEY (qc_inspection_id) REFERENCES qc_inspections(id) ON DELETE CASCADE
);

-- Allow linking media to a weight detail row (optional). Run once; ignore error if column already exists.
ALTER TABLE qc_media ADD COLUMN qc_inspection_weight_detail_id INT NULL;
