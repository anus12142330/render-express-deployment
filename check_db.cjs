const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config({ path: path.join(__dirname, '.env') });

async function check() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'portal_db'
    });

    try {
        const [tables] = await connection.query('SHOW TABLES LIKE "sales_order%"');
        const tableNames = tables.map(t => Object.values(t)[0]);
        let output = 'Tables:\n' + tableNames.join('\n') + '\n\n';

        for (const table of tableNames) {
            output += `Columns for ${table}:\n`;
            const [columns] = await connection.query(`DESCRIBE ${table}`);
            output += columns.map(c => `${c.Field} (${c.Type})`).join('\n') + '\n\n';
        }

        fs.writeFileSync('db_report.txt', output);
        console.log('Report written to db_report.txt');

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await connection.end();
    }
}

check();
