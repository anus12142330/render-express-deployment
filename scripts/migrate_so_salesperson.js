import mysql from 'mysql2/promise';

async function setup() {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'portal_db'
    });

    try {
        const [columns] = await conn.execute('SHOW COLUMNS FROM sales_orders');
        const columnNames = columns.map(c => c.Field);

        if (!columnNames.includes('sales_person_id')) {
            console.log('Adding sales_person_id to sales_orders...');
            await conn.execute('ALTER TABLE sales_orders ADD COLUMN sales_person_id INT');
        } else {
            console.log('sales_person_id already exists in sales_orders');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await conn.end();
    }
}

setup();
