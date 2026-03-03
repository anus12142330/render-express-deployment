import db from '../db.js';

async function checkData() {
    try {
        const [rows] = await db.promise().query('SELECT * FROM sales_order_attachments ORDER BY id DESC LIMIT 10');
        console.log('DATA:', JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error('Error selecting from sales_order_attachments:', err);
    } finally {
        process.exit();
    }
}

checkData();
