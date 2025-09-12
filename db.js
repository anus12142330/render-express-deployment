import mysql from 'mysql2';

const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'portal_db'
});

export default db;
