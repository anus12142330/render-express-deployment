import fs from 'fs';
import path from 'path';
const dir = 'uploads/sales_orders/header';
const files = fs.readdirSync(dir);
const stats = files.map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime }));
stats.sort((a, b) => b.mtime - a.mtime);
fs.writeFileSync('header_dates.txt', JSON.stringify(stats.slice(0, 10), null, 2));
process.exit();
