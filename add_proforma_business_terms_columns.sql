-- Add business_terms and business_terms_id to proforma_invoice.
-- Run this once if your table doesn't have these columns yet.
-- (Skip or ignore errors if columns already exist.)

ALTER TABLE proforma_invoice ADD COLUMN business_terms TEXT NULL;
ALTER TABLE proforma_invoice ADD COLUMN business_terms_id INT NULL;
