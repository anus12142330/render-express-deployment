import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/authz.js';

const router = Router();

let didSeedDefaults = false;

async function isSuperAdmin(userId) {
  if (!userId) return false;
  const [rows] = await db.promise().query(
    `SELECT 1
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
      WHERE ur.user_id=? AND r.name='Super Admin'
      LIMIT 1`,
    [userId]
  );
  return !!rows?.[0];
}

async function seedDefaultWidgetsIfNeeded() {
  if (didSeedDefaults) return;
  didSeedDefaults = true;

  // Seed "Top Selling Products" widget if missing.
  const widgetKey = 'sales_top_products';
  const [exists] = await db.promise().query(
    `SELECT id FROM dashboard_widgets WHERE widget_key = ? LIMIT 1`,
    [widgetKey]
  );
  if (exists?.[0]?.id) return;

  // Map by role names (more portable than hardcoding role ids)
  const roleNames = ['Super Admin', 'Admin', 'Sales', 'Accounts', 'Operation', 'Operation Manager', 'Delivery'];
  const [roleRows] = await db.promise().query(
    `SELECT id, name FROM role WHERE name IN (?)`,
    [roleNames]
  );
  const roleIds = (roleRows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO dashboard_widgets
       (widget_key, title, widget_type, route_path, api_path, module_key, action_key, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        widgetKey,
        'Top Selling Products',
        'kpi',
        null,
        '/api/dashboard/kpi/sales/top-products',
        'Dashboard',
        'view',
        50,
        1
      ]
    );
    const widgetId = ins.insertId;

    if (roleIds.length) {
      await conn.query(
        `INSERT INTO dashboard_widget_roles (widget_id, role_id)
         VALUES ${roleIds.map(() => '(?, ?)').join(',')}`,
        roleIds.flatMap((rid) => [widgetId, rid])
      );
    }

    await conn.commit();
    // eslint-disable-next-line no-console
    console.log(`[DASHBOARD_WIDGETS] Seeded default widget: ${widgetKey} (roles: ${roleIds.join(',') || 'none'})`);
  } catch (e) {
    await conn.rollback();
    // eslint-disable-next-line no-console
    console.error('[DASHBOARD_WIDGETS] Seed defaults failed:', e?.message || e);
  } finally {
    conn.release();
  }
}

async function requireSuperAdmin(req, res, next) {
  const userId = req.user?.id || req.session?.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  if (await isSuperAdmin(userId)) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

function normalizeWidgetRow(r) {
  return {
    id: r.id,
    widget_key: r.widget_key,
    title: r.title,
    widget_type: r.widget_type,
    route_path: r.route_path,
    api_path: r.api_path,
    module_key: r.module_key,
    action_key: r.action_key,
    sort_order: r.sort_order ?? 0,
    is_active: r.is_active === 1 || r.is_active === true,
    role_ids: typeof r.role_ids === 'string'
      ? r.role_ids.split(',').filter(Boolean).map((x) => Number(x))
      : []
  };
}

router.get('/roles', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const [rows] = await db.promise().query(`SELECT id, name, description FROM role ORDER BY name`);
    res.json({ roles: rows || [] });
  } catch (e) {
    next(e);
  }
});

router.get('/', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT w.*,
              GROUP_CONCAT(wr.role_id ORDER BY wr.role_id) AS role_ids
         FROM dashboard_widgets w
         LEFT JOIN dashboard_widget_roles wr ON wr.widget_id = w.id
        GROUP BY w.id
        ORDER BY w.sort_order ASC, w.id ASC`
    );
    res.json({ rows: (rows || []).map(normalizeWidgetRow) });
  } catch (e) {
    next(e);
  }
});

router.post('/', requireAuth, requireSuperAdmin, async (req, res, next) => {
  const {
    widget_key,
    title,
    widget_type = 'link',
    route_path = null,
    api_path = null,
    module_key = null,
    action_key = null,
    sort_order = 0,
    is_active = true,
    role_ids = []
  } = req.body || {};

  if (!widget_key || !title) return res.status(400).json({ error: 'widget_key and title are required' });

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO dashboard_widgets
       (widget_key, title, widget_type, route_path, api_path, module_key, action_key, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [widget_key, title, widget_type, route_path, api_path, module_key, action_key, Number(sort_order) || 0, is_active ? 1 : 0]
    );
    const widgetId = ins.insertId;

    const roleIds = Array.isArray(role_ids) ? role_ids.map((x) => Number(x)).filter(Boolean) : [];
    if (roleIds.length) {
      await conn.query(
        `INSERT INTO dashboard_widget_roles (widget_id, role_id)
         VALUES ${roleIds.map(() => '(?, ?)').join(',')}`,
        roleIds.flatMap((rid) => [widgetId, rid])
      );
    }

    await conn.commit();
    res.json({ id: widgetId });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  const widgetId = Number(req.params.id);
  if (!widgetId) return res.status(400).json({ error: 'Invalid id' });

  const {
    widget_key,
    title,
    widget_type,
    route_path,
    api_path,
    module_key,
    action_key,
    sort_order,
    is_active,
    role_ids
  } = req.body || {};

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE dashboard_widgets
          SET widget_key=?,
              title=?,
              widget_type=?,
              route_path=?,
              api_path=?,
              module_key=?,
              action_key=?,
              sort_order=?,
              is_active=?
        WHERE id=?`,
      [
        widget_key,
        title,
        widget_type,
        route_path ?? null,
        api_path ?? null,
        module_key ?? null,
        action_key ?? null,
        Number(sort_order) || 0,
        is_active ? 1 : 0,
        widgetId
      ]
    );

    await conn.query(`DELETE FROM dashboard_widget_roles WHERE widget_id=?`, [widgetId]);
    const roleIds = Array.isArray(role_ids) ? role_ids.map((x) => Number(x)).filter(Boolean) : [];
    if (roleIds.length) {
      await conn.query(
        `INSERT INTO dashboard_widget_roles (widget_id, role_id)
         VALUES ${roleIds.map(() => '(?, ?)').join(',')}`,
        roleIds.flatMap((rid) => [widgetId, rid])
      );
    }

    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  const widgetId = Number(req.params.id);
  if (!widgetId) return res.status(400).json({ error: 'Invalid id' });

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM dashboard_widget_roles WHERE widget_id=?`, [widgetId]);
    await conn.query(`DELETE FROM dashboard_widgets WHERE id=?`, [widgetId]);
    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

// For Dashboard rendering: return widgets allowed for current user.
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    await seedDefaultWidgetsIfNeeded();
    const userId = req.user?.id || req.session?.user?.id;
    const superAdmin = await isSuperAdmin(userId);

    if (superAdmin) {
      const [rows] = await db.promise().query(
        `SELECT w.*,
                GROUP_CONCAT(wr.role_id ORDER BY wr.role_id) AS role_ids
           FROM dashboard_widgets w
           LEFT JOIN dashboard_widget_roles wr ON wr.widget_id = w.id
          WHERE w.is_active=1
          GROUP BY w.id
          ORDER BY w.sort_order ASC, w.id ASC`
      );
      return res.json({ rows: (rows || []).map(normalizeWidgetRow) });
    }

    const [rows] = await db.promise().query(
      `SELECT DISTINCT w.*,
              GROUP_CONCAT(wr.role_id ORDER BY wr.role_id) AS role_ids
         FROM dashboard_widgets w
         JOIN dashboard_widget_roles wr ON wr.widget_id = w.id
         JOIN user_role ur ON ur.role_id = wr.role_id AND ur.user_id=?
        WHERE w.is_active=1
        GROUP BY w.id
        ORDER BY w.sort_order ASC, w.id ASC`,
      [userId]
    );
    res.json({ rows: (rows || []).map(normalizeWidgetRow) });
  } catch (e) {
    next(e);
  }
});

export default router;

