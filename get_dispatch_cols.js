import db from './db.js';
(async () => {
    try {
        const [rows] = await db.promise().query("DESCRIBE sales_order_dispatches");
        console.log("Columns:", rows.map(r => r.Field).join(', '));
        process.exit(0);
    } catch (err) {
        process.exit(1);
    }
})();
