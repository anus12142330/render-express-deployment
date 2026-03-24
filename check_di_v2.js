import db from './db.js';
(async () => {
    try {
        const [rows] = await db.promise().query("DESCRIBE sales_order_dispatch_items");
        rows.forEach(r => console.log(r.Field, r.Type, r.Null, r.Default));
        process.exit(0);
    } catch (err) {
        process.exit(1);
    }
})();
