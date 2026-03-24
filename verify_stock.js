import db from './db.js';

async function verify() {
    try {
        const [products] = await db.promise().query('SELECT id, product_name FROM products WHERE product_name LIKE "%Red Lady Papaya%"');
        const pId = products[0].id;
        console.log('PID:', pId);

        const [stock] = await db.promise().query('SELECT * FROM inventory_stock_batches WHERE product_id = ?', [pId]);
        console.log('STOCK:', JSON.stringify(stock));

        const [dispatchItems] = await db.promise().query(`
            SELECT di.* 
            FROM sales_order_dispatch_items di
            JOIN sales_order_items soi ON soi.id = di.sales_order_item_id
            WHERE soi.product_id = ?
            ORDER BY di.id DESC LIMIT 5
        `, [pId]);
        console.log('DISPATCH_ITEMS:', JSON.stringify(dispatchItems));
        
    } catch (err) {
        console.error(err);
    }
    process.exit(0);
}

verify();
