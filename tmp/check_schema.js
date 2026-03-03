import db from '../db.js';

async function checkSchema() {
    try {
        const [rows] = await db.promise().query('DESCRIBE sales_order_attachments');
        console.log('SCHEMA:', JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error('Error describing sales_order_attachments:', err);
    } finally {
        process.exit();
    }
}

checkSchema();
