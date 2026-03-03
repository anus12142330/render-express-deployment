import db from './db.js';

async function run() {
    try {
        const [rows] = await db.promise().query('DESCRIBE sales_order_attachments');
        console.log(JSON.stringify(rows, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
