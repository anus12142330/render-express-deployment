-- Update acc_bank_details table to add new fields
-- Add opening_balance, opening_balance_date, currency_code fields

ALTER TABLE `acc_bank_details`
ADD COLUMN IF NOT EXISTS `opening_balance` DECIMAL(18, 2) DEFAULT 0.00 AFTER `acc_currency`,
ADD COLUMN IF NOT EXISTS `opening_balance_date` DATE NULL AFTER `opening_balance`,
ADD COLUMN IF NOT EXISTS `currency_code` VARCHAR(10) NULL AFTER `acc_currency`;

-- Update currency_code from acc_currency if it exists (assuming acc_currency is a currency ID)
-- This is a placeholder - adjust based on your currency table structure
-- UPDATE acc_bank_details SET currency_code = (SELECT code FROM currency WHERE id = acc_bank_details.acc_currency) WHERE acc_currency IS NOT NULL;

