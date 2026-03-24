import db from './db.js';
(async () => {
    try {
        const [rows] = await db.promise().query("DESCRIBE sales_order_dispatch_items");
        console.log("Columns:", rows.map(r => ({ Field: r.Field, Extra: r.Extra, Null: r.Null, Default: r.Default })));
        process.exit(0);
    } catch (err) {
        process.exit(1);
    }
})();
