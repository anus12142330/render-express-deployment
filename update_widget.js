import db from './db.js';

async function update() {
  try {
    await db.promise().query("UPDATE dashboard_widgets SET api_path = '/api/dashboard/kpi/sales/summary', title='Sales Overview' WHERE widget_key = 'sp_sales_kpis'");
    console.log("Updated successfully");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
update();
