-- Create required Chart of Accounts for Opening Balances
-- These accounts are needed for GL posting

-- Opening Balance Equity (Equity account)
INSERT INTO acc_chart_accounts (name, account_type_id, parent_id, is_active, created_at)
SELECT 'Opening Balance Equity', 
       (SELECT id FROM acc_account_types WHERE name = 'Equity' LIMIT 1),
       NULL,
       1,
       NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM acc_chart_accounts WHERE name = 'Opening Balance Equity'
);

-- Accounts Receivable Control (Asset account)
INSERT INTO acc_chart_accounts (name, account_type_id, parent_id, is_active, created_at)
SELECT 'Accounts Receivable Control',
       (SELECT id FROM acc_account_types WHERE name = 'Asset' LIMIT 1),
       NULL,
       1,
       NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM acc_chart_accounts WHERE name = 'Accounts Receivable Control'
);

-- Customer Advances (Liability account)
INSERT INTO acc_chart_accounts (name, account_type_id, parent_id, is_active, created_at)
SELECT 'Customer Advances',
       (SELECT id FROM acc_account_types WHERE name = 'Liability' LIMIT 1),
       NULL,
       1,
       NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM acc_chart_accounts WHERE name = 'Customer Advances'
);

-- Accounts Payable Control (Liability account)
INSERT INTO acc_chart_accounts (name, account_type_id, parent_id, is_active, created_at)
SELECT 'Accounts Payable Control',
       (SELECT id FROM acc_account_types WHERE name = 'Liability' LIMIT 1),
       NULL,
       1,
       NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM acc_chart_accounts WHERE name = 'Accounts Payable Control'
);

-- Supplier Advances (Asset account)
INSERT INTO acc_chart_accounts (name, account_type_id, parent_id, is_active, created_at)
SELECT 'Supplier Advances',
       (SELECT id FROM acc_account_types WHERE name = 'Asset' LIMIT 1),
       NULL,
       1,
       NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM acc_chart_accounts WHERE name = 'Supplier Advances'
);
