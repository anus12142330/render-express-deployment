const mysql = require('mysql2/promise');
const crypto = require('crypto');

async function populateUniqId() {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'reddiaro_portaldb'
    });

    try {
        const [rows] = await conn.query('SELECT id FROM sales_orders WHERE uniqid IS NULL OR uniqid = ""');
        console.log(`Found ${rows.length} rows to update.`);

        for (const row of rows) {
            const uniqid = `so_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
            await conn.query('UPDATE sales_orders SET uniqid = ? WHERE id = ?', [uniqid, row.id]);
        }

        console.log('Update complete.');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await conn.end();
    }
}

populateUniqId();
