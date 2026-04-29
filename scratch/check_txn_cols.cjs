const mysql = require('mysql2/promise');
const config = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'reddiaro_portaldb'
};

async function checkColumns() {
  try {
    const connection = await mysql.createConnection(config);
    const [rows] = await connection.query('SHOW COLUMNS FROM inventory_transactions');
    rows.forEach((row, i) => {
      console.log(`${i+1}: ${row.Field}`);
    });
    await connection.end();
  } catch (err) {
    console.error(err);
  }
}

checkColumns();
