import mysql from 'mysql2/promise';

async function setup() {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'portal_db'
    });

    try {
        const [columns] = await conn.execute('SHOW COLUMNS FROM sales_orders');
        const columnNames = columns.map(c => c.Field);

        if (!columnNames.includes('terms_conditions')) {
            console.log('Adding terms_conditions to sales_orders...');
            await conn.execute('ALTER TABLE sales_orders ADD COLUMN terms_conditions TEXT');
        } else {
            console.log('terms_conditions already exists in sales_orders');
        }

        const [tables] = await conn.execute("SHOW TABLES LIKE 'sales_order_attachments'");
        if (tables.length === 0) {
            console.log('Creating sales_order_attachments table...');
            await conn.execute(`
                CREATE TABLE sales_order_attachments (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    client_id INT NOT NULL,
                    sales_order_id INT NOT NULL,
                    scope VARCHAR(50) DEFAULT 'HEADER',
                    file_original_name VARCHAR(255),
                    file_name VARCHAR(255),
                    file_type VARCHAR(100),
                    file_size INT,
                    file_path VARCHAR(255),
                    uploaded_by INT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
        } else {
            console.log('sales_order_attachments table already exists');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await conn.end();
    }
}

setup();
