import db from '../db.js';

async function checkCounts() {
    try {
        const [rows] = await db.promise().query('SELECT scope, COUNT(*) as count FROM sales_order_attachments GROUP BY scope');
        console.log('COUNTS:', JSON.stringify(rows));
    } catch (err) {
        process.exit(1);
    } finally {
        process.exit();
    }
}

checkCounts();
