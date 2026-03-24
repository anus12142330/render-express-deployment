import db from './db.js';
(async () => {
    try {
        const [rows] = await db.promise().query("DESCRIBE sales_order_dispatch_items");
        console.log("Columns in sales_order_dispatch_items:");
        console.table(rows.map(r => ({ Field: r.Field, Type: r.Type, Null: r.Null, Key: r.Key, Default: r.Default, Extra: r.Extra })));
        process.exit(0);
    } catch (err) {
        console.error("Error describing table:", err);
        process.exit(1);
    }
})();
