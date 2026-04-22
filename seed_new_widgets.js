import db from './db.js';

async function seed() {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    const widgets = [
      {
        key: 'so_pending_accept',
        title: 'SO Pending Accept',
        api: '/api/dashboard/kpi/operations/pending-accept',
        route: '/sales/sales-orders',
        roles: [1, 2, 3, 5, 6, 10] // Super Admin, Admin, Sales, Ops, Ops Mgr, Delivery
      },
      {
        key: 'so_pending_delivery',
        title: 'SO Pending Delivery',
        api: '/api/dashboard/kpi/operations/pending-delivery',
        route: '/sales/sales-orders',
        roles: [1, 2, 3, 5, 6, 10]
      },
      {
        key: 'so_pending_invoice',
        title: 'SO Pending Invoice',
        api: '/api/dashboard/kpi/operations/pending-invoice',
        route: '/sales/sales-orders',
        roles: [1, 2, 3, 11] // Super Admin, Admin, Sales, Accounts
      }
    ];

    for (const w of widgets) {
      // Check if exists
      const [existing] = await conn.query("SELECT id FROM dashboard_widgets WHERE widget_key = ?", [w.key]);
      let widgetId;
      if (existing.length > 0) {
        widgetId = existing[0].id;
        await conn.query(
          "UPDATE dashboard_widgets SET title=?, api_path=?, route_path=?, is_active=1 WHERE id=?",
          [w.title, w.api, w.route, widgetId]
        );
      } else {
        const [ins] = await conn.query(
          "INSERT INTO dashboard_widgets (widget_key, title, widget_type, api_path, route_path, is_active, sort_order) VALUES (?, ?, 'kpi', ?, ?, 1, 10)",
          [w.key, w.title, w.api, w.route]
        );
        widgetId = ins.insertId;
      }

      // Sync roles
      await conn.query("DELETE FROM dashboard_widget_roles WHERE widget_id = ?", [widgetId]);
      for (const roleId of w.roles) {
        await conn.query("INSERT INTO dashboard_widget_roles (widget_id, role_id) VALUES (?, ?)", [widgetId, roleId]);
      }
    }

    await conn.commit();
    console.log("Widgets seeded successfully");
    process.exit(0);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    process.exit(1);
  } finally {
    conn.release();
  }
}
seed();
