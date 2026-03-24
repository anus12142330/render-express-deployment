import db from './db.js';

const schema = `
CREATE TABLE IF NOT EXISTS sales_returns (
    id INT(10) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    return_no VARCHAR(50) NOT NULL UNIQUE,
    company_id INT(10) UNSIGNED,
    customer_id INT(200) NOT NULL,
    invoice_id INT(10) UNSIGNED NOT NULL,
    return_date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'Draft',
    return_reason TEXT,
    settlement_method VARCHAR(50),
    warehouse_id INT(11),
    remarks TEXT,
    created_by INT(200),
    approved_by INT(200),
    received_by INT(200),
    settled_by INT(200),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES vendor(id),
    FOREIGN KEY (invoice_id) REFERENCES ar_invoices(id),
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sales_return_items (
    id INT(10) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sales_return_id INT(10) UNSIGNED NOT NULL,
    product_id INT(11) NOT NULL,
    invoice_item_id INT(10) UNSIGNED NOT NULL,
    qty_invoiced DECIMAL(18,4) DEFAULT 0,
    qty_delivered DECIMAL(18,4) DEFAULT 0,
    qty_returned DECIMAL(18,4) DEFAULT 0,
    unit_price DECIMAL(18,4) DEFAULT 0,
    tax_amount DECIMAL(18,4) DEFAULT 0,
    return_amount DECIMAL(18,4) DEFAULT 0,
    stock_action VARCHAR(50),
    item_reason TEXT,
    qc_status VARCHAR(50),
    condition_note TEXT,
    FOREIGN KEY (sales_return_id) REFERENCES sales_returns(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (invoice_item_id) REFERENCES ar_invoice_lines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sales_return_attachments (
    id INT(10) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sales_return_id INT(10) UNSIGNED NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    uploaded_by INT(200),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sales_return_id) REFERENCES sales_returns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sales_return_logs (
    id INT(10) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sales_return_id INT(10) UNSIGNED NOT NULL,
    action VARCHAR(100) NOT NULL,
    old_status VARCHAR(50),
    new_status VARCHAR(50),
    remarks TEXT,
    action_by INT(200),
    action_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sales_return_id) REFERENCES sales_returns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function setupDatabase() {
    try {
        console.log('Creating Sales Return tables...');
        // Split by semicolon and run each query
        const queries = schema.split(';').filter(q => q.trim().length > 0);
        for (const q of queries) {
            await db.promise().query(q);
        }
        console.log('Tables created successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Error creating tables:', err);
        process.exit(1);
    }
}

setupDatabase();
