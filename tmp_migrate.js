
import db from './db.js';
const sql = `ALTER TABLE sales_order_dispatch_items ADD COLUMN ap_bill_line_id INT NULL AFTER sales_order_item_id;`;
db.query(sql, (err) => {
    if (err) {
        if (err.errno === 1060) {
            console.log("Column already exists");
            process.exit(0);
        }
        console.error(err);
        process.exit(1);
    }
    console.log("Column added successfully");
    process.exit(0);
});
