const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

async function check() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'portal_db'
    });

    try {
        const salesOrderId = 17;
        const clientId = 1;
        const sql = `SELECT soi.*, p.product_name, u.acronyms as uom_name, t.tax_name,
         (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = soi.product_id ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) AS thumbnail_url
         FROM sales_order_items soi
         LEFT JOIN products p ON soi.product_id = p.id
         LEFT JOIN uom_master u ON soi.uom_id = u.id
         LEFT JOIN taxes t ON soi.tax_id = t.id
         WHERE soi.sales_order_id = ? AND soi.client_id = ?`;

        const [rows] = await connection.query(sql, [salesOrderId, clientId]);
        console.log('Items found:', rows.length);

    } catch (err) {
        console.error('SQL Error:', err.message);
    } finally {
        await connection.end();
    }
}

check();
