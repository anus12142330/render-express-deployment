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
        const id = 17;
        const clientId = 1;

        console.log('Testing getSalesOrderHeader...');
        const [header] = await connection.query(`SELECT so.* FROM sales_orders so WHERE so.id = ? AND so.client_id = ?`, [id, clientId]);
        console.log('Header found:', !!header[0]);

        console.log('Testing getSalesOrderItems...');
        const [items] = await connection.query(`SELECT soi.* FROM sales_order_items soi WHERE soi.sales_order_id = ? AND soi.client_id = ?`, [id, clientId]);
        console.log('Items:', items.length);

        console.log('Testing getSalesOrderAttachments...');
        const [attachments] = await connection.query(`SELECT * FROM sales_order_attachments WHERE sales_order_id = ? AND client_id = ?`, [id, clientId]);
        console.log('Attachments:', attachments.length);

        console.log('Testing getSalesOrderDispatches...');
        const [dispatches] = await connection.query(`SELECT * FROM sales_order_dispatches WHERE sales_order_id = ? AND client_id = ?`, [id, clientId]);
        console.log('Dispatches:', dispatches.length);

        console.log('Testing getSalesOrderAudit...');
        const [audit] = await connection.query(`SELECT * FROM history WHERE module = "sales_order" AND module_id = ?`, [id]);
        console.log('Audit:', audit.length);

    } catch (err) {
        console.error('SQL Error:', err.message);
    } finally {
        await connection.end();
    }
}

check();
