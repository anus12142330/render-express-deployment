const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

async function check() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'portal_db'
    });

    try {
        const id = 17;
        const clientId = 1;
        console.log(`Testing query for id=${id}, clientId=${clientId}`);

        const sql = `SELECT so.*, 
                v.display_name as customer_name, 
                comp.name as company_name, 
                w.warehouse_name as warehouse_name, 
                u.name as sales_person_name,
                s.name as status,
                s.name as status_name,
                s.name as status_label,
                s.bg_colour as status_bg,
                s.colour as status_text_color,
                urb.name as edit_requested_by_name,
                ucomp.name as completed_by_name,
                cur.name as currency_code,
                latest_d.vehicle_no,
                latest_d.driver_name,
                latest_d.dispatched_at,
                udisp.name as dispatched_by_name,
                udeliv.name as delivered_by_name,
                ucr.name as created_by_name,
                uom_sum.summary as total_quantity
         FROM sales_orders so
         LEFT JOIN vendor v ON so.customer_id = v.id
         LEFT JOIN company_settings comp ON so.company_id = comp.id
         LEFT JOIN warehouses w ON so.warehouse_id = w.id
         LEFT JOIN \`user\` u ON so.sales_person_id = u.id
         LEFT JOIN status s ON so.status_id = s.id
         LEFT JOIN \`user\` urb ON so.edit_requested_by = urb.id
         LEFT JOIN \`user\` ucomp ON so.completed_by = ucomp.id
         LEFT JOIN \`user\` ucr ON so.created_by = ucr.id
         LEFT JOIN \`user\` udeliv ON so.delivered_by = udeliv.id
         LEFT JOIN currency cur ON so.currency_id = cur.id
         LEFT JOIN sales_order_dispatches latest_d ON latest_d.id = (
            SELECT id FROM sales_order_dispatches 
            WHERE sales_order_id = so.id 
            ORDER BY dispatched_at DESC LIMIT 1
         )
         LEFT JOIN \`user\` udisp ON latest_d.dispatched_by = udisp.id
         LEFT JOIN (
            SELECT sales_order_id, GROUP_CONCAT(CONCAT(qty, ' ', acronyms) SEPARATOR ', ') as summary
            FROM (
                SELECT soi_inner.sales_order_id, (SUM(soi_inner.quantity) + 0) as qty, u_inner.acronyms
                FROM sales_order_items soi_inner
                JOIN uom_master u_inner ON soi_inner.uom_id = u_inner.id
                GROUP BY soi_inner.sales_order_id, u_inner.id
            ) t1
            GROUP BY sales_order_id
         ) uom_sum ON so.id = uom_sum.sales_order_id
         WHERE so.id = ? AND so.client_id = ?`;

        const [rows] = await connection.query(sql, [id, clientId]);
        console.log('Query successful, header found:', !!rows[0]);
        if (rows[0]) console.log('Order No:', rows[0].order_no);

    } catch (err) {
        console.error('SQL Error:', err.message);
    } finally {
        await connection.end();
    }
}

check();
