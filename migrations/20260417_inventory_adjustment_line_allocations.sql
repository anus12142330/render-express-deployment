-- Inventory adjustment: persist batch allocations used during posting (FIFO / explicit batch)
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS inventory_adjustment_line_allocations (
  id INT NOT NULL AUTO_INCREMENT,
  inventory_adjustment_id INT NOT NULL,
  line_id INT NULL,
  product_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  batch_id INT NULL,
  qty_allocated DECIMAL(18,6) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(18,6) NOT NULL DEFAULT 0,
  value_allocated DECIMAL(18,6) NOT NULL DEFAULT 0,
  allocation_method VARCHAR(20) NOT NULL DEFAULT 'FIFO',
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ia_alloc_adj (inventory_adjustment_id),
  KEY idx_ia_alloc_line (line_id),
  KEY idx_ia_alloc_prod_wh (product_id, warehouse_id),
  KEY idx_ia_alloc_batch (batch_id)
);

