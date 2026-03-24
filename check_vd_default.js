import db from './db.js';
(async () => {
    try {
        const [rows] = await db.promise().query("DESCRIBE sales_dispatch_vehicle_driver");
        rows.forEach(r => console.log(r.Field, r.Default, r.Extra));
        process.exit(0);
    } catch (err) {
        process.exit(1);
    }
})();
