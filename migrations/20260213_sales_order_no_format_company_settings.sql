-- Add configurable sales order number format to company_settings (master).
-- Placeholders: {prefix}, {YY}, {YYYY}, {MM}, {seq} (seq padded to 3 digits).
-- NULL or empty = use legacy format: {prefix}SO-{YY}-{MM}-{seq}
ALTER TABLE company_settings
  ADD COLUMN sales_order_no_format VARCHAR(128) NULL DEFAULT NULL
  COMMENT 'e.g. {prefix}SO-{YY}-{MM}-{seq}. Placeholders: {prefix}, {YY}, {YYYY}, {MM}, {seq}'
  AFTER company_prefix;
