const mysql = require('mysql2/promise');
const config = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'reddiaro_portaldb'
};

async function alterTable() {
  try {
    const connection = await mysql.createConnection(config);
    console.log('Adding columns to qc_sell_recheck_entries...');
    await connection.query(`
      ALTER TABLE qc_sell_recheck_entries
      ADD COLUMN usable_quantity_units DECIMAL(12,3) NULL AFTER quantity_net_weight,
      ADD COLUMN discard_quantity_units DECIMAL(12,3) NULL AFTER usable_quantity_units
    `);
    console.log('Columns added successfully.');
    await connection.end();
  } catch (err) {
    console.error(err);
  }
}

alterTable();
