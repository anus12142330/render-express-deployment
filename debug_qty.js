import db from './db.js';
db.query(`
    SELECT so.id, so.order_no, 
           (SELECT SUM(quantity) FROM sales_order_items WHERE sales_order_id = so.id) as sum_qty,
           (SELECT SUM(ordered_quantity) FROM sales_order_items WHERE sales_order_id = so.id) as sum_ordered_qty
    FROM sales_orders so
    ORDER BY so.id DESC
    LIMIT 10
`, (err, rows) => {
    if (err) console.error(err);
    else console.log(JSON.stringify(rows, null, 2));
    process.exit();
});
