const mysql = require('mysql2/promise');
const config = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'reddiaro_portaldb'
};

async function checkTable() {
  try {
    const connection = await mysql.createConnection(config);
    const [rows] = await connection.query('DESCRIBE qc_lot_items');
    console.log(JSON.stringify(rows, null, 2));
    await connection.end();
  } catch (err) {
    console.error(err);
  }
}

checkTable();
