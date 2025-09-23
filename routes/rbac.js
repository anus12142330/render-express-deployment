// routes/rbac.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requirePerm } from '../middleware/authz.js';
const router = Router();
const q = async (sql, p=[]) => (await db.promise().query(sql, p))[0];

router.get('/metadata', requireAuth, async (_req, res) => {
  const modules = await q(`
    SELECT m.id, m.key_name, m.group_name, m.display_name, m.sort_order
    FROM menu_module m
    JOIN menu_group g ON m.group_name = g.group_name
    WHERE m.is_active = 1
    ORDER BY g.sort_order, m.sort_order, m.display_name`);
  const actions = await q(`SELECT id,key_name,display_name,is_core,sort_order
                           FROM permission_action ORDER BY sort_order,id`);
  const groups = {};
  modules.forEach(m => { (groups[m.group_name] ||= []).push(m); });
  res.json({ groups, actions });
});

router.get('/roles/:id', requireAuth, async (req, res) => {
  const roleId = Number(req.params.id);
  try {
    const [role] = await q(`SELECT id,name,description FROM role WHERE id=?`, [roleId]);
    if (!role) return res.status(404).json({ ok: false, error: 'Role not found' });

    const mods = await q(`SELECT id,key_name FROM menu_module WHERE is_active=1`);
    const acts = await q(`SELECT id,key_name FROM permission_action`);
    const perms = await q(`SELECT module_id,action_id,allowed FROM role_permission WHERE role_id=?`, [roleId]);

    const mById = Object.fromEntries(mods.map(m => [m.id, m.key_name]));
    const aById = Object.fromEntries(acts.map(a => [a.id, a.key_name]));
    const out = {};
    perms.forEach(p => {
      const mk = mById[p.module_id], ak = aById[p.action_id];
      if (!mk || !ak) return;
      (out[mk] ||= {})[ak] = p.allowed === 1;
    });
    res.json({ role, permissions: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/roles', requirePerm('roles', 'create'), async (req, res) => {
  const { name, description, permissions } = req.body || {};
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(`INSERT INTO role (name, description) VALUES (?,?)`, [name, description || null]);
    await saveMatrix(conn, r.insertId, permissions);
    await conn.commit();
    res.json({ ok:true, id: r.insertId });
  } catch (e) {
    await conn.rollback(); res.status(500).json({ ok:false, error: e.message });
  } finally { conn.release(); }
});

router.get('/roles', requireAuth, async (_req, res) => {
  const roles = await q(`SELECT id, name, description, is_active, created_at FROM role ORDER BY name`);
  res.json({ roles });
});

router.put('/roles/:id', requirePerm('roles', 'edit'), async (req, res) => {
  const roleId = Number(req.params.id);
  const { name, description, permissions } = req.body || {};
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`UPDATE role SET name=?, description=? WHERE id=?`, [name, description || null, roleId]);
    await conn.query(`DELETE FROM role_permission WHERE role_id=?`, [roleId]);
    await saveMatrix(conn, roleId, permissions);
    await conn.commit();
    res.json({ ok:true });
  } catch (e) {
    await conn.rollback(); res.status(500).json({ ok:false, error: e.message });
  } finally { conn.release(); }
});

router.delete('/roles/:id', requirePerm('roles', 'delete'), async (req, res) => {
  const roleId = Number(req.params.id);
  const conn = await db.promise().getConnection();
  try {
    // This performs a hard delete. For this to work cleanly, ensure your DB has
    // `ON DELETE CASCADE` for the `role_id` foreign key in the `role_permission` table.
    await conn.beginTransaction();
    await conn.query(`DELETE FROM role_permission WHERE role_id=?`, [roleId]);
    const [result] = await conn.query(`DELETE FROM role WHERE id=?`, [roleId]);
    await conn.commit();

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: 'Role not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback(); res.status(500).json({ ok:false, error: e.message });
  } finally { conn.release(); }
});

async function saveMatrix(conn, roleId, permissions = {}) {
  const [mods] = await conn.query(`SELECT id,key_name FROM menu_module WHERE is_active=1`);
  const [acts] = await conn.query(`SELECT id,key_name FROM permission_action`);
  const m = Object.fromEntries(mods.map(x => [x.key_name, x.id]));
  const a = Object.fromEntries(acts.map(x => [x.key_name, x.id]));
  const rows = [];
  for (const [modKey, map] of Object.entries(permissions || {})) {
    const mid = m[modKey]; if (!mid) continue;
    for (const [actKey, val] of Object.entries(map || {})) {
      const aid = a[actKey]; if (!aid) continue;
      rows.push([roleId, mid, aid, val ? 1 : 0]);
    }
  }
  if (rows.length) {
    await conn.query(`INSERT INTO role_permission (role_id,module_id,action_id,allowed) VALUES ?`, [rows]);
  }
}

export default router;
