import db from './db.js';
(async () => {
    try {
        const [rows] = await db.promise().query("DESCRIBE sales_order_dispatch_items");
        console.log("Columns:", rows.map(r => r.Field).join(', '));
        process.exit(0);
    } catch (err) {
        console.error("Error describes table:", err);
        process.exit(1);
    }
})();
