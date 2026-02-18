import { Router } from "express";
import db from "../db.js";
import { signMobileToken, authenticateMobile } from "../middleware/mobileAuth.js";

const router = Router();

const loadMobilePermissions = async (userId) => {
  const [adm] = await db.promise().query(
    `SELECT 1
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
      WHERE ur.user_id=? AND r.name='Super Admin'
      LIMIT 1`,
    [userId]
  );
  const isSuperAdmin = !!adm?.length;
  if (isSuperAdmin) {
    return { isSuperAdmin: true, permissions: { QualityCheck: { view: true } } };
  }

  const [rows] = await db.promise().query(
    `SELECT m.key_name AS module_key, a.key_name AS action_key
       FROM user_role ur
       JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.allowed = 1
       JOIN menu_module m ON m.id = rp.module_id
       JOIN permission_action a ON a.id = rp.action_id
      WHERE ur.user_id = ?`,
    [userId]
  );

  const permissions = {};
  rows.forEach((row) => {
    if (!row?.module_key || !row?.action_key) return;
    (permissions[row.module_key] ||= {})[row.action_key] = true;
  });

  return { isSuperAdmin: false, permissions };
};

router.post("/login", async (req, res) => {
  const identifier = String(req.body?.identifier ?? "").trim();
  const password = String(req.body?.password ?? "").trim();
  if (!identifier || !password) {
    return res.status(400).json({ success: false, message: "Missing credentials" });
  }

  try {
    const [columns] = await db.promise().query("SHOW COLUMNS FROM `user` LIKE 'user_name'");
    const hasUserName = columns.length > 0;
    const loginSql = hasUserName
      ? "SELECT id, email FROM user WHERE (email = ? OR name = ? OR user_name = ?) AND password = ? AND is_inactive = 0"
      : "SELECT id, email FROM user WHERE (email = ? OR name = ?) AND password = ? AND is_inactive = 0";
    const loginParams = hasUserName
      ? [identifier, identifier, identifier, password]
      : [identifier, identifier, password];

    const [loginRows] = await db.promise().query(loginSql, loginParams);
    if (loginRows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    const loggedInUser = loginRows[0];

    const [detailsRows] = await db.promise().query(`
      SELECT
          u.id, u.name AS user_name, u.designation, u.email, u.photo_path,
          d.name AS department_name, GROUP_CONCAT(r.name) as roles
      FROM \`user\` u
      LEFT JOIN department d ON d.id = u.department_id
      LEFT JOIN user_role ur ON ur.user_id = u.id
      LEFT JOIN role r ON r.id = ur.role_id
      WHERE u.id = ?
      GROUP BY u.id
    `, [loggedInUser.id]);

    const userWithDetails = detailsRows[0] || null;
    if (userWithDetails?.roles) {
      userWithDetails.roles = userWithDetails.roles.split(",");
    }

    const token = signMobileToken({ id: loggedInUser.id, email: loggedInUser.email });
    const { isSuperAdmin, permissions } = await loadMobilePermissions(loggedInUser.id);
    return res.json({ success: true, token, user: userWithDetails, isSuperAdmin, permissions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Login failed" });
  }
});

// GET /api/mobile/dashboard - Total Order, Total Income, trend (for mobile app dashboard UI)
router.get("/dashboard", authenticateMobile, async (req, res) => {
  try {
    const period = String(req.query.period || "year").toLowerCase(); // 'month' | 'year'
    const isMonth = period === "month";
    const userId = req.mobileUser.id;

    const { isSuperAdmin } = await loadMobilePermissions(userId);

    let currentTotal = 0;
    let currentCount = 0;
    let prevTotal = 0;
    let chartData = [];

    const userFilter = isSuperAdmin ? "" : " AND so.created_by = ?";
    const params = isSuperAdmin ? [] : [userId];

    try {
      // Current Period
      const [rows] = await db.promise().query(
        isMonth
          ? `SELECT COUNT(*) AS count, COALESCE(SUM(so.grand_total / NULLIF(c.conversion_rate, 0)), 0) AS total 
             FROM sales_orders so
             LEFT JOIN currency c ON c.id = so.currency_id
             WHERE so.created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
               AND so.created_at < DATE_FORMAT(NOW(), '%Y-%m-01') + INTERVAL 1 MONTH
               ${userFilter}`
          : `SELECT COUNT(*) AS count, COALESCE(SUM(so.grand_total / NULLIF(c.conversion_rate, 0)), 0) AS total 
             FROM sales_orders so
             LEFT JOIN currency c ON c.id = so.currency_id
             WHERE so.created_at >= DATE_FORMAT(NOW(), '%Y-01-01')
               AND so.created_at < DATE_FORMAT(NOW(), '%Y-01-01') + INTERVAL 1 YEAR
               ${userFilter}`,
        params
      );
      currentCount = Number(rows[0]?.count ?? 0);
      currentTotal = Number(rows[0]?.total ?? 0);

      // Previous Period
      const [prevRows] = await db.promise().query(
        isMonth
          ? `SELECT COALESCE(SUM(so.grand_total / NULLIF(c.conversion_rate, 0)), 0) AS total 
             FROM sales_orders so
             LEFT JOIN currency c ON c.id = so.currency_id
             WHERE so.created_at >= DATE_FORMAT(NOW(), '%Y-%m-01') - INTERVAL 1 MONTH
               AND so.created_at < DATE_FORMAT(NOW(), '%Y-%m-01')
               ${userFilter}`
          : `SELECT COALESCE(SUM(so.grand_total / NULLIF(c.conversion_rate, 0)), 0) AS total 
             FROM sales_orders so
             LEFT JOIN currency c ON c.id = so.currency_id
             WHERE so.created_at >= DATE_FORMAT(NOW(), '%Y-01-01') - INTERVAL 1 YEAR
               AND so.created_at < DATE_FORMAT(NOW(), '%Y-01-01')
               ${userFilter}`,
        params
      );
      prevTotal = Number(prevRows[0]?.total ?? 0);

      const interval = isMonth ? "1 MONTH" : "1 YEAR";
      const [chartRows] = await db.promise().query(
        `SELECT COALESCE(SUM(so.grand_total / NULLIF(c.conversion_rate, 0)), 0) AS value, DATE(so.created_at) AS date
         FROM sales_orders so
         LEFT JOIN currency c ON c.id = so.currency_id
         WHERE so.created_at >= NOW() - INTERVAL ${interval}
         ${userFilter}
         GROUP BY DATE(so.created_at)
         ORDER BY date ASC
         LIMIT 30`,
        params
      );
      chartData = (chartRows || []).map((r) => ({ value: Number(r.value), date: r.date }));
    } catch (dbErr) {
      console.warn("mobile dashboard db error:", dbErr.message);
    }

    const trend = prevTotal > 0 ? Math.round(((currentTotal - prevTotal) / prevTotal) * 100) : 0;

    res.json({
      totalOrder: currentCount,
      totalIncome: Math.round(currentTotal * 100) / 100,
      trend,
      period,
      chartData,
    });
  } catch (err) {
    console.error("mobile dashboard:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to load dashboard" });
  }
});

// Update biometric setting
router.put("/settings/biometric", authenticateMobile, async (req, res) => {
  try {
    const userId = req.mobileUser.id;
    const { enabled } = req.body;
    await db.promise().query(
      "UPDATE `user` SET biometric_login_enabled = ? WHERE id = ?",
      [enabled ? 1 : 0, userId]
    );
    res.json({ success: true, message: `Biometric login ${enabled ? "enabled" : "disabled"}` });
  } catch (err) {
    console.error("Biometric update error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to update setting" });
  }
});

router.get("/me", authenticateMobile, async (req, res) => {
  try {
    const userId = req.mobileUser?.id;
    const [rows] = await db.promise().query(`
      SELECT
          u.id, u.name AS user_name, u.designation, u.email, u.photo_path,
          d.name AS department_name, GROUP_CONCAT(r.name) as roles
      FROM \`user\` u
      LEFT JOIN department d ON d.id = u.department_id
      LEFT JOIN user_role ur ON ur.user_id = u.id
      LEFT JOIN role r ON r.id = ur.role_id
      WHERE u.id = ?
      GROUP BY u.id
    `, [userId]);
    const user = rows[0] || null;
    if (user?.roles) user.roles = user.roles.split(",");
    const { isSuperAdmin, permissions } = await loadMobilePermissions(userId);
    res.json({ success: true, user, isSuperAdmin, permissions });
  } catch (err) {
    console.error("Failed to load user:", err);
    res.status(500).json({ success: false, message: "Failed to load user" });
  }
});

export default router;
