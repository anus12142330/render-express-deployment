import { getOrderDetail } from './src/modules/sales-order/salesOrder.service.js';
import db from './db.js';

async function test() {
    try {
        const detail = await getOrderDetail({ id: 1, clientId: 1 });
        console.log("DETAIL SUCCESS:", !!detail);
    } catch (err) {
        console.error("FAIL CAUGHT:", err);
    } finally {
        process.exit();
    }
}

test();
