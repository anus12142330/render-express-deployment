-- Add Need business terms (Yes/No, default Yes) to proforma invoice.
-- When Yes, "Other Terms and Conditions" is shown in PDF; when No, it is hidden.
ALTER TABLE proforma_invoice
ADD COLUMN need_business_terms TINYINT(1) NOT NULL DEFAULT 1
COMMENT '1=Yes show other terms in PDF, 0=No'
AFTER other_terms;
