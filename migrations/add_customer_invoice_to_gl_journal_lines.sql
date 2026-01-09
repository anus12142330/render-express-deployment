-- Add supplier_id and invoice_id fields to gl_journal_lines table
-- supplier_id: stores supplier_id (vendor_id) for outward payments
-- invoice_id: stores bill_id (for bill allocations) or po_id (for advance allocations)
-- Note: Using supplier_id instead of customer_id to avoid foreign key constraint conflicts
-- (customer_id already exists with FK to customer table, but we need to store vendor_id)

-- Add supplier_id column (for supplier/vendor payments)
ALTER TABLE `gl_journal_lines`
  ADD COLUMN `supplier_id` INT(11) NULL DEFAULT NULL COMMENT 'Supplier/Vendor ID (for outward payments)' AFTER `buyer_id`;

-- Add invoice_id column
ALTER TABLE `gl_journal_lines`
  ADD COLUMN `invoice_id` INT(11) NULL DEFAULT NULL COMMENT 'Bill ID (for bill allocations) or PO ID (for advance allocations)' AFTER `supplier_id`;

-- Create indexes for better query performance
CREATE INDEX `idx_gl_journal_lines_supplier_id` ON `gl_journal_lines` (`supplier_id`);
CREATE INDEX `idx_gl_journal_lines_invoice_id` ON `gl_journal_lines` (`invoice_id`);
