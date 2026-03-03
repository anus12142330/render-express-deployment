import db from './db.js';
import { insertAttachments } from './src/modules/sales-order/salesOrder.repo.js';

async function run() {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const rows = [[
            0, // client_id (0 instead of null)
            29, // sales order
            null,
            'COMPLETION',
            'test.png',
            'test_abc.png',
            'image/png',
            1000,
            'uploads/sales_orders/completion/test_abc.png',
            8,
            new Date()
        ]];
        await insertAttachments(conn, rows);
        console.log("Insert success");
        await conn.rollback();
    } catch (e) {
        console.error("Insert failed:", e);
        await conn.rollback();
    } finally {
        conn.release();
    }
    process.exit(0);
}

run();
