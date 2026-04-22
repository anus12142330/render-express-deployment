import { Router } from 'express';
import db from '../db.js';
import { hasPermission, requireAuth } from '../middleware/authz.js';

const router = Router();

/** Modules whose view_all / record_all (or Admin/Dispatch roles) unlock org-wide sales-person filter on dashboard KPIs. */
const DASHBOARD_SCOPE_MODULE_KEYS = ['SalesOrders', 'Sales', 'AR', 'Dashboard', 'Accounts'];

/**
 * True when user may filter KPIs by any sales user (Super Admin, Admin, Dispatch roles, or view_all/record_all on scope modules).
 */
async function resolveDashboardCanViewAll(userId) {
  if (!userId) return false;
  const [roles] = await db.promise().query(
    `SELECT r.name, r.id FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?`,
    [userId]
  );
  const roleNames = roles.map((r) => r.name);
  const roleIds = roles.map((r) => Number(r.id));

  const isSuperAdmin = roleNames.includes('Super Admin') || roleIds.includes(1);
  const isAdmin = roleNames.includes('Admin') || roleIds.includes(2);
  const isDispatch =
    roleNames.includes('Delivery') ||
    roleNames.includes('Operation') ||
    roleNames.includes('Operation Manager') ||
    roleNames.includes('Dispatch') ||
    roleIds.includes(10) ||
    roleIds.includes(11);

  if (isSuperAdmin || isAdmin || isDispatch) return true;

  for (const mk of DASHBOARD_SCOPE_MODULE_KEYS) {
    // eslint-disable-next-line no-await-in-loop
    const viewAll = await hasPermission(userId, mk, 'view_all');
    // eslint-disable-next-line no-await-in-loop
    const recordAll = await hasPermission(userId, mk, 'record_all');
    if (viewAll || recordAll) return true;
  }
  return false;
}

async function loadSalesUsersForFilter() {
  const [urows] = await db.promise().query(
    `SELECT u.id, u.name
       FROM user_role ur
       JOIN \`user\` u ON u.id = ur.user_id
      WHERE ur.role_id = 3 AND (u.is_inactive = 0 OR u.is_inactive IS NULL)
      ORDER BY u.name`
  );
  return (urows || []).map((r) => ({ id: r.id, name: r.name }));
}

function parsePeriod(raw) {
  const p = String(raw || 'today').toLowerCase();
  if (['today', 'week', 'month', 'last_month', 'all'].includes(p)) return p;
  return 'today';
}

function rangeSql(period) {
  // Returns { whereSql, params } for a date range filter on column alias `dcol`
  // Use like: WHERE dcol >= ? AND dcol < ?
  const now = new Date();
  if (period === 'all') return { whereSql: '1=1', params: [] };

  // Use MySQL date math to avoid JS timezone issues; build SQL fragments
  // We'll return SQL that compares against expressions (no params needed).
  switch (period) {
    case 'today':
      return { whereSql: "dcol >= CURDATE() AND dcol < (CURDATE() + INTERVAL 1 DAY)", params: [] };
    case 'week':
      return { whereSql: "dcol >= (CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY) AND dcol < ((CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY) + INTERVAL 7 DAY)", params: [] };
    case 'month':
      return { whereSql: "dcol >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND dcol < (DATE_FORMAT(CURDATE(), '%Y-%m-01') + INTERVAL 1 MONTH)", params: [] };
    case 'last_month':
      return { whereSql: "dcol >= (DATE_FORMAT(CURDATE(), '%Y-%m-01') - INTERVAL 1 MONTH) AND dcol < DATE_FORMAT(CURDATE(), '%Y-%m-01')", params: [] };
    default:
      return { whereSql: "dcol >= CURDATE() AND dcol < (CURDATE() + INTERVAL 1 DAY)", params: [] };
  }
}

async function loadCompanyCurrencyCode() {
  const [csRows] = await db.promise().query(
    `SELECT cs.base_currency,
            c.name AS currency_code
       FROM company_settings cs
       LEFT JOIN currency c
         ON c.id = cs.base_currency OR c.name = cs.base_currency
      LIMIT 1`
  );
  return csRows?.[0]?.currency_code || csRows?.[0]?.base_currency || 'AED';
}

function parseIntParam(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// GET /api/dashboard/sales-persons — sales users for header filter (same scope as KPI sales filter)
router.get('/sales-persons', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.session?.user?.id;
    const canViewAll = await resolveDashboardCanViewAll(userId);
    if (!canViewAll) {
      return res.json({ users: [] });
    }
    const users = await loadSalesUsersForFilter();
    res.json({ users });
  } catch (e) {
    next(e);
  }
});

// GET /api/dashboard/kpi/sales/top-products?period=...&sales_user_id=...&offset=0&limit=5
router.get('/kpi/sales/top-products', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.session?.user?.id;
    const period = parsePeriod(req.query.period);
    const canViewAll = await resolveDashboardCanViewAll(userId);

    const selectedSalesUserId = parseIntParam(req.query.sales_user_id, null);
    const effectiveUserId = (canViewAll && selectedSalesUserId && selectedSalesUserId > 0)
      ? selectedSalesUserId
      : (!canViewAll ? userId : null);

    const offset = Math.max(0, parseIntParam(req.query.offset, 0));
    const limit = Math.min(50, Math.max(1, parseIntParam(req.query.limit, 5)));

    const soRange = rangeSql(period);
    const soUserFilter = effectiveUserId ? ' AND so.created_by = ?' : '';
    const userParams = effectiveUserId ? [effectiveUserId] : [];
    const soDateExpr = 'COALESCE(so.created_at, so.order_date)';

    // sales_order_items column names can vary across installs; try common variants.
    const queries = [
      {
        productIdCol: 'i.product_id',
        qtyCol: 'i.quantity',
        amountExpr: 'COALESCE(i.line_total, (i.quantity * i.unit_price), 0)',
        productNameExpr: `pr.product_name`,
      },
      {
        productIdCol: 'i.item_id',
        qtyCol: 'i.qty',
        amountExpr: 'COALESCE(i.total, (i.qty * i.price), 0)',
        productNameExpr: `pr.product_name`,
      }
    ];

    let rows = null;
    for (const q of queries) {
      try {
        const sql = `
          SELECT
            ${q.productIdCol} AS product_id,
            ${q.productNameExpr} AS product_name,
            MAX(pd.packing_alias) AS packing_alias,
            COUNT(DISTINCT so.id) AS sales_order_count,
            COALESCE(SUM(${q.qtyCol}), 0) AS total_qty,
            COALESCE(SUM(${q.amountExpr}), 0) AS so_value
          FROM sales_orders so
          JOIN sales_order_items i ON i.sales_order_id = so.id
          LEFT JOIN products pr ON pr.id = ${q.productIdCol}
          LEFT JOIN product_details pd ON pd.product_id = ${q.productIdCol}
          WHERE (so.is_deleted = 0 OR so.is_deleted IS NULL)
            AND (pr.is_deleted = 0 OR pr.is_deleted IS NULL)
            AND (pr.is_active = 1 OR pr.is_active IS NULL)
            AND ${soRange.whereSql.replaceAll('dcol', soDateExpr)}
            ${soUserFilter}
          GROUP BY ${q.productIdCol}, ${q.productNameExpr}
          ORDER BY so_value DESC
          LIMIT ? OFFSET ?
        `;
        const [r] = await db.promise().query(sql, [...soRange.params, ...userParams, limit + 1, offset]);
        rows = r;
        break;
      } catch (e) {
        const msg = String(e?.message || '').toLowerCase();
        // keep trying other variants
        if (msg.includes('unknown column') || msg.includes("doesn't exist")) continue;
        throw e;
      }
    }
    if (!Array.isArray(rows)) {
      return res.status(500).json({
        error: 'Top products query failed',
        hint: 'Schema mismatch: share SHOW COLUMNS FROM sales_order_items and sales_orders'
      });
    }

    const currencyCode = await loadCompanyCurrencyCode();
    const list = Array.isArray(rows) ? rows : [];
    const hasMore = list.length > limit;
    const slice = hasMore ? list.slice(0, limit) : list;
    const productIds = slice.map((r) => Number(r.product_id)).filter((n) => Number.isFinite(n) && n > 0);

    // Invoice selling value per product (base currency) — from ar_invoice_lines + ar_invoices
    const invRange = rangeSql(period);
    const invUserFilter = effectiveUserId ? ' AND ai.user_id = ?' : '';
    const invUserParams = effectiveUserId ? [effectiveUserId] : [];

    const invoiceValueByProductId = new Map();
    if (productIds.length) {
      const invSqlCreatedAt = `
        SELECT
          ail.product_id AS product_id,
          COALESCE(SUM(COALESCE(ail.line_total, (ail.quantity * ail.rate), 0) * COALESCE(c.conversion_rate, 1)), 0) AS invoice_value
        FROM ar_invoice_lines ail
        JOIN ar_invoices ai ON ai.id = ail.invoice_id
        LEFT JOIN currency c ON c.id = ai.currency_id
        LEFT JOIN status s ON s.id = ai.status_id
        WHERE (ai.is_deleted = 0 OR ai.is_deleted IS NULL)
          AND (s.name IS NULL OR s.name <> 'CANCELLED')
          AND ${invRange.whereSql.replaceAll('dcol', 'ai.created_at')}
          ${invUserFilter}
          AND ail.product_id IN (?)
        GROUP BY ail.product_id
      `;

      try {
        const [invRows] = await db.promise().query(invSqlCreatedAt, [...invRange.params, ...invUserParams, productIds]);
        for (const r of (invRows || [])) {
          invoiceValueByProductId.set(Number(r.product_id), Number(r.invoice_value || 0));
        }
      } catch (e1) {
        const msg1 = String(e1?.message || '').toLowerCase();
        if (!(msg1.includes('unknown column') && msg1.includes('created_at'))) throw e1;
        const invSqlInvoiceDate = invSqlCreatedAt.replaceAll('ai.created_at', 'ai.invoice_date');
        const [invRows] = await db.promise().query(invSqlInvoiceDate, [...invRange.params, ...invUserParams, productIds]);
        for (const r of (invRows || [])) {
          invoiceValueByProductId.set(Number(r.product_id), Number(r.invoice_value || 0));
        }
      }
    }

    const outRows = slice.map((r) => {
      const pid = Number(r.product_id);
      const invoiceValue = invoiceValueByProductId.get(pid) || 0;
      return ({
        product_id: pid,
        product_name: r.product_name || `#${pid}`,
        packing_alias: r.packing_alias || null,
        sales_order_count: Number(r.sales_order_count || 0),
        so_value: Math.round(Number(r.so_value || 0) * 100) / 100,
        invoice_value: Math.round(Number(invoiceValue || 0) * 100) / 100,
      });
    });

    res.json({
      title: 'Top Products Selling',
      period,
      currency_code: currencyCode,
      total: outRows.length,
      rows: outRows,
      offset,
      limit,
      has_more: hasMore
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/dashboard/kpi/sales/today-approved?sales_user_id=...
// Interpreted as: Approved customer invoices today (status contains 'APPROV').
router.get('/kpi/sales/today-approved', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.session?.user?.id;
    const canViewAll = await resolveDashboardCanViewAll(userId);
    const selectedSalesUserId = parseIntParam(req.query.sales_user_id, null);
    const effectiveUserId = (canViewAll && selectedSalesUserId && selectedSalesUserId > 0)
      ? selectedSalesUserId
      : (!canViewAll ? userId : null);
    const invUserFilter = effectiveUserId ? ' AND inv.user_id = ?' : '';
    const userParams = effectiveUserId ? [effectiveUserId] : [];

    const currencyCode = await loadCompanyCurrencyCode();

    // Try approved_at first; fall back to updated_at.
    let rows = [];
    try {
      const [r] = await db.promise().query(
        `SELECT inv.id,
                COALESCE(inv.invoice_number, inv.bill_no, inv.doc_no, inv.uniqid, inv.invoice_uuid, inv.id) AS bill_no,
                (inv.total * COALESCE(c.conversion_rate, 1)) AS value,
                inv.approved_at AS approved_at
           FROM ar_invoices inv
           LEFT JOIN currency c ON c.id = inv.currency_id
           LEFT JOIN status s ON s.id = inv.status_id
          WHERE inv.approved_at >= CURDATE()
            AND inv.approved_at < (CURDATE() + INTERVAL 1 DAY)
            AND (s.name IS NULL OR UPPER(s.name) LIKE '%APPROV%')
            AND (inv.is_deleted = 0 OR inv.is_deleted IS NULL)
            ${invUserFilter}
          ORDER BY inv.approved_at DESC
          LIMIT 50`,
        userParams
      );
      rows = r;
    } catch (e1) {
      const msg1 = String(e1?.message || '').toLowerCase();
      if (!(msg1.includes('unknown column') && msg1.includes('approved_at'))) throw e1;
      const [r] = await db.promise().query(
        `SELECT inv.id,
                COALESCE(inv.invoice_number, inv.bill_no, inv.doc_no, inv.uniqid, inv.invoice_uuid, inv.id) AS bill_no,
                (inv.total * COALESCE(c.conversion_rate, 1)) AS value,
                inv.updated_at AS approved_at
           FROM ar_invoices inv
           LEFT JOIN currency c ON c.id = inv.currency_id
           LEFT JOIN status s ON s.id = inv.status_id
          WHERE inv.updated_at >= CURDATE()
            AND inv.updated_at < (CURDATE() + INTERVAL 1 DAY)
            AND (s.name IS NULL OR UPPER(s.name) LIKE '%APPROV%')
            AND (inv.is_deleted = 0 OR inv.is_deleted IS NULL)
            ${invUserFilter}
          ORDER BY inv.updated_at DESC
          LIMIT 50`,
        userParams
      );
      rows = r;
    }

    res.json({
      title: 'Today Approved',
      currency_code: currencyCode,
      total: rows.length,
      rows: rows.map((r) => ({
        id: r.id,
        bill_no: String(r.bill_no ?? ''),
        value: Math.round(Number(r.value || 0) * 100) / 100,
        approved_at: r.approved_at
      }))
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/dashboard/kpi/ar/invoices/list?period=...&sales_user_id=...&offset=0&limit=5
// Returns recent customer invoices for the dashboard modal (Bill No / Customer / Value).
router.get('/kpi/ar/invoices/list', requireAuth, async (req, res, next) => {
  try {
    console.log('[DASHBOARD_INVOICES_LIST] handler invoked');
    const userId = req.user?.id || req.session?.user?.id;
    const period = parsePeriod(req.query.period);
    const canViewAll = await resolveDashboardCanViewAll(userId);

    const selectedSalesUserId = parseIntParam(req.query.sales_user_id, null);
    const effectiveUserId = (canViewAll && selectedSalesUserId && selectedSalesUserId > 0)
      ? selectedSalesUserId
      : (!canViewAll ? userId : null);

    const offset = Math.max(0, parseIntParam(req.query.offset, 0));
    const limit = Math.min(50, Math.max(1, parseIntParam(req.query.limit, 5)));

    // Creator/user field varies across installs; try common variants.
    const userFilters = [
      { sql: effectiveUserId ? ' AND inv.user_id = ?' : '', params: effectiveUserId ? [effectiveUserId] : [] },
      { sql: effectiveUserId ? ' AND inv.created_by = ?' : '', params: effectiveUserId ? [effectiveUserId] : [] }
    ];

    const invRange = rangeSql(period);
    const invDateExpr = 'COALESCE(inv.created_at, inv.invoice_date)';

    const currencyCode = await loadCompanyCurrencyCode();

    // Customer master is stored in `vendor` (company_type_id='2' => customer) in this codebase.
    // Keep a fallback variant for installs where the customer join is different.
    const queryVariants = [
      {
        customerJoin: "LEFT JOIN vendor v ON v.id = inv.customer_id AND v.company_type_id = '2'",
        customerName: "COALESCE(v.display_name, v.company_name, CAST(inv.customer_id AS CHAR), '')"
      },
      {
        customerJoin: '',
        customerName: "CAST(inv.customer_id AS CHAR)"
      }
    ];

    // Total field varies.
    const totalExprs = [
      'inv.total',
      'inv.grand_total',
      'inv.total_amount',
      'inv.net_total'
    ];

    let rows = null;
    let hasMore = false;

    for (const uf of userFilters) {
      for (const qv of queryVariants) {
        for (const totalExpr of totalExprs) {
          const baseSql = `
            SELECT
              inv.id AS invoice_id,
              inv.invoice_number AS invoice_no,
              ${qv.customerName} AS customer_name,
              (${totalExpr} * COALESCE(cur.conversion_rate, 1)) AS value
            FROM ar_invoices inv
            ${qv.customerJoin}
            LEFT JOIN currency cur ON cur.id = inv.currency_id
            LEFT JOIN status s ON s.id = inv.status_id
            WHERE ${invRange.whereSql.replaceAll('dcol', invDateExpr)}
              AND (s.name IS NULL OR s.name <> 'CANCELLED')
              ${uf.sql}
          `;

          const sqlWithIsDeleted = `
            ${baseSql}
              AND (inv.is_deleted = 0 OR inv.is_deleted IS NULL)
            ORDER BY ${invDateExpr} DESC
            LIMIT ? OFFSET ?
          `;
          const sqlWithoutIsDeleted = `
            ${baseSql}
            ORDER BY ${invDateExpr} DESC
            LIMIT ? OFFSET ?
          `;

          try {
            const [r] = await db.promise().query(sqlWithIsDeleted, [...invRange.params, ...uf.params, limit + 1, offset]);
            rows = r;
          } catch (e1) {
            const msg1 = String(e1?.message || '').toLowerCase();
            // If schema doesn't have is_deleted, retry without it.
            if (msg1.includes('unknown column') && msg1.includes('is_deleted')) {
              try {
                const [r] = await db.promise().query(sqlWithoutIsDeleted, [...invRange.params, ...uf.params, limit + 1, offset]);
                rows = r;
              } catch (e2) {
                const msg2 = String(e2?.message || '').toLowerCase();
                // Keep trying other variants on common schema mismatches.
                if (msg2.includes('unknown column') || msg2.includes("doesn't exist")) continue;
                throw e2;
              }
            } else if (msg1.includes('unknown column') || msg1.includes("doesn't exist")) {
              continue;
            } else {
              throw e1;
            }
          }

          if (Array.isArray(rows)) {
            hasMore = rows.length > limit;
            rows = hasMore ? rows.slice(0, limit) : rows;
            break;
          }
        }
        if (Array.isArray(rows)) break;
      }
      if (Array.isArray(rows)) break;
    }

    if (!Array.isArray(rows)) rows = [];

    res.json({
      period,
      currency_code: currencyCode,
      offset,
      limit,
      has_more: hasMore,
      rows: rows.map((r) => ({
        invoice_id: r.invoice_id,
        invoice_no: String(r.invoice_no ?? ''),
        customer_name: String(r.customer_name ?? ''),
        value: Math.round(Number(r.value || 0) * 100) / 100
      }))
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/dashboard/kpi/inventory/stock?period=...&offset=0&limit=5
// Returns current stock on hand + IN TRANSIT qty per product.
router.get('/kpi/inventory/stock', requireAuth, async (req, res, next) => {
  try {
    const offset = Math.max(0, parseIntParam(req.query.offset, 0));
    const limit = Math.min(100, Math.max(1, parseIntParam(req.query.limit, 5)));

    // Stock on hand and in-transit are point-in-time for the dashboard (no date filter).
    const sql = `
      SELECT
        p.id AS product_id,
        p.product_name AS product_name,
        MAX(pd.packing_alias) AS packing_alias,
        MAX(COALESCE(um.acronyms, um.name)) AS uom,
        COALESCE(soh.qty_on_hand, 0) AS stock_on_hand,
        COALESCE(tr.qty_in_transit, 0) AS stock_in_transit
      FROM products p
      LEFT JOIN product_details pd ON pd.product_id = p.id
      LEFT JOIN uom_master um ON um.id = pd.uom_id
      LEFT JOIN (
        SELECT isb.product_id, SUM(isb.qty_on_hand) AS qty_on_hand
        FROM inventory_stock_batches isb
        WHERE isb.qty_on_hand > 0
        GROUP BY isb.product_id
      ) soh ON soh.product_id = p.id
      LEFT JOIN (
        SELECT it.product_id, SUM(it.qty) AS qty_in_transit
        FROM inventory_transactions it
        WHERE it.movement = 'IN TRANSIT'
          AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
        GROUP BY it.product_id
      ) tr ON tr.product_id = p.id
      WHERE (p.is_deleted = 0 OR p.is_deleted IS NULL)
        AND (p.is_active = 1 OR p.is_active IS NULL)
        AND (COALESCE(soh.qty_on_hand, 0) > 0 OR COALESCE(tr.qty_in_transit, 0) > 0)
      GROUP BY p.id, p.product_name, soh.qty_on_hand, tr.qty_in_transit
      ORDER BY (COALESCE(soh.qty_on_hand, 0) + COALESCE(tr.qty_in_transit, 0)) DESC, p.product_name ASC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await db.promise().query(sql, [limit + 1, offset]);
    const list = Array.isArray(rows) ? rows : [];
    const hasMore = list.length > limit;
    const slice = hasMore ? list.slice(0, limit) : list;

    const countSql = `
      SELECT COUNT(*) AS total_count
      FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN (
          SELECT isb.product_id, SUM(isb.qty_on_hand) AS qty_on_hand
          FROM inventory_stock_batches isb
          WHERE isb.qty_on_hand > 0
          GROUP BY isb.product_id
        ) soh ON soh.product_id = p.id
        LEFT JOIN (
          SELECT it.product_id, SUM(it.qty) AS qty_in_transit
          FROM inventory_transactions it
          WHERE it.movement = 'IN TRANSIT'
            AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
          GROUP BY it.product_id
        ) tr ON tr.product_id = p.id
        WHERE (p.is_deleted = 0 OR p.is_deleted IS NULL)
          AND (p.is_active = 1 OR p.is_active IS NULL)
          AND (COALESCE(soh.qty_on_hand, 0) > 0 OR COALESCE(tr.qty_in_transit, 0) > 0)
        GROUP BY p.id
      ) x
    `;
    const [countRows] = await db.promise().query(countSql);

    res.json({
      title: 'Inventory Stock',
      period: 'all',
      offset,
      limit,
      total_count: Number(countRows?.[0]?.total_count ?? 0),
      has_more: hasMore,
      rows: slice.map((r) => ({
        product_id: Number(r.product_id),
        product_name: r.product_name || `#${r.product_id}`,
        packing_alias: r.packing_alias || null,
        uom: r.uom || null,
        stock_on_hand: Number(r.stock_on_hand || 0),
        stock_in_transit: Number(r.stock_in_transit || 0),
      }))
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/dashboard/kpi/ar/invoices/list?period=...&sales_user_id=...&offset=0&limit=5
// "Bill list" = customer invoice list (AR invoices).
router.get('/kpi/ar/invoices/list', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.session?.user?.id;
    const period = parsePeriod(req.query.period);
    const canViewAll = await resolveDashboardCanViewAll(userId);

    const selectedSalesUserId = parseIntParam(req.query.sales_user_id, null);
    const effectiveUserId = (canViewAll && selectedSalesUserId && selectedSalesUserId > 0)
      ? selectedSalesUserId
      : (!canViewAll ? userId : null);

    const offset = Math.max(0, parseIntParam(req.query.offset, 0));
    const limit = Math.min(100, Math.max(1, parseIntParam(req.query.limit, 5)));

    const invRange = rangeSql(period);
    const invDateExpr = 'COALESCE(inv.created_at, inv.invoice_date)';
    const invUserFilter = effectiveUserId ? ' AND inv.user_id = ?' : '';
    const userParams = effectiveUserId ? [effectiveUserId] : [];

    const currencyCode = await loadCompanyCurrencyCode();

    const sql = `
      SELECT
        inv.id AS invoice_id,
        (inv.invoice_number) AS invoice_no,
        COALESCE(NULLIF(v.company_name, ''), v.display_name, v.name, CONCAT('Customer #', inv.customer_id)) AS customer_name,
        (inv.total * COALESCE(c.conversion_rate, 1)) AS value,
        ${invDateExpr} AS invoice_date
      FROM ar_invoices inv
      LEFT JOIN vendor v ON v.id = inv.customer_id
      LEFT JOIN currency c ON c.id = inv.currency_id
      LEFT JOIN status s ON s.id = inv.status_id
      WHERE ${invRange.whereSql.replaceAll('dcol', invDateExpr)}
        AND (inv.is_deleted = 0 OR inv.is_deleted IS NULL)
        AND (s.name IS NULL OR s.name <> 'CANCELLED')
        ${invUserFilter}
      ORDER BY ${invDateExpr} DESC, inv.id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await db.promise().query(sql, [...invRange.params, ...userParams, limit + 1, offset]);
    const list = Array.isArray(rows) ? rows : [];
    const hasMore = list.length > limit;
    const slice = hasMore ? list.slice(0, limit) : list;

    const countSql = `
      SELECT COUNT(*) AS total_count
      FROM ar_invoices inv
      LEFT JOIN status s ON s.id = inv.status_id
      WHERE ${invRange.whereSql.replaceAll('dcol', invDateExpr)}
        AND (inv.is_deleted = 0 OR inv.is_deleted IS NULL)
        AND (s.name IS NULL OR s.name <> 'CANCELLED')
        ${invUserFilter}
    `;
    const [countRows] = await db.promise().query(countSql, [...invRange.params, ...userParams]);

    res.json({
      title: 'Customer Invoices',
      period,
      currency_code: currencyCode,
      offset,
      limit,
      total_count: Number(countRows?.[0]?.total_count ?? 0),
      has_more: hasMore,
      rows: slice.map((r) => ({
        invoice_id: Number(r.invoice_id),
        invoice_no: String(r.invoice_no ?? ''),
        customer_name: String(r.customer_name ?? ''),
        value: Math.round(Number(r.value || 0) * 100) / 100,
        invoice_date: r.invoice_date
      }))
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/dashboard/kpi/sales/orders/list?period=...&sales_user_id=...&offset=0&limit=5
// Sales order list for dashboard details modal.
router.get('/kpi/sales/orders/list', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.session?.user?.id;
    const period = parsePeriod(req.query.period);
    const canViewAll = await resolveDashboardCanViewAll(userId);

    const selectedSalesUserId = parseIntParam(req.query.sales_user_id, null);
    const effectiveUserId = (canViewAll && selectedSalesUserId && selectedSalesUserId > 0)
      ? selectedSalesUserId
      : (!canViewAll ? userId : null);

    const offset = Math.max(0, parseIntParam(req.query.offset, 0));
    const limit = Math.min(100, Math.max(1, parseIntParam(req.query.limit, 5)));

    const soRange = rangeSql(period);
    const soDateExpr = 'COALESCE(so.created_at, so.order_date)';
    const userFilter = effectiveUserId ? ' AND so.created_by = ?' : '';
    const userParams = effectiveUserId ? [effectiveUserId] : [];

    // customer master can vary; try vendor (this codebase) first, then customer/customers, then fallback to id.
    const variants = [
      {
        join: "LEFT JOIN vendor v ON v.id = so.customer_id AND v.company_type_id = '2'",
        cust: "COALESCE(NULLIF(v.display_name,''), NULLIF(v.company_name,''), CONCAT('Customer #', so.customer_id))"
      },
      {
        join: 'LEFT JOIN customer c ON c.id = so.customer_id',
        cust: "COALESCE(NULLIF(c.display_name,''), NULLIF(c.name,''), CONCAT('Customer #', so.customer_id))"
      },
      {
        join: 'LEFT JOIN customers c ON c.id = so.customer_id',
        cust: "COALESCE(NULLIF(c.display_name,''), NULLIF(c.name,''), CONCAT('Customer #', so.customer_id))"
      },
      {
        join: '',
        cust: "CAST(so.customer_id AS CHAR)"
      }
    ];

    const totalExprs = [
      'so.grand_total',
      'so.total_amount',
      'so.net_total',
      'so.amount_total'
    ];

    let rows = null;
    let totalCount = 0;
    for (const v of variants) {
      for (const totalExpr of totalExprs) {
        const sqlBase = `
          SELECT
            so.id,
            so.order_no,
            ${v.cust} AS customer_name,
            so.order_date,
            COALESCE(${totalExpr}, 0) AS total,
            st.name AS status_name,
            COALESCE(u.name, u2.name, 'System') AS sales_person
          FROM sales_orders so
          ${v.join}
          LEFT JOIN status st ON st.id = so.status_id
          LEFT JOIN \`user\` u ON u.id = so.sales_person_id
          LEFT JOIN \`user\` u2 ON u2.id = so.created_by
          WHERE ${soRange.whereSql.replaceAll('dcol', soDateExpr)}
            ${userFilter}
        `;

        // try is_deleted then is_delete then none
        const candidates = [
          { sql: `${sqlBase} AND (so.is_deleted = 0 OR so.is_deleted IS NULL)`, deleteWhere: '(so.is_deleted = 0 OR so.is_deleted IS NULL)' },
          { sql: `${sqlBase} AND (so.is_delete = 0 OR so.is_delete IS NULL)`, deleteWhere: '(so.is_delete = 0 OR so.is_delete IS NULL)' },
          { sql: sqlBase, deleteWhere: null }
        ];

        try {
          for (const c of candidates) {
            try {
              const [r] = await db.promise().query(`${c.sql} ORDER BY ${soDateExpr} DESC, so.id DESC LIMIT ? OFFSET ?`, [...soRange.params, ...userParams, limit + 1, offset]);
              rows = r;

              const countSql = `
                SELECT COUNT(*) AS total_count
                FROM sales_orders so
                ${v.join}
                WHERE ${soRange.whereSql.replaceAll('dcol', soDateExpr)}
                  ${userFilter}
                  ${c.deleteWhere ? ` AND ${c.deleteWhere}` : ''}
              `;
              const [cntRows] = await db.promise().query(countSql, [...soRange.params, ...userParams]);
              totalCount = Number(cntRows?.[0]?.total_count ?? 0);
              break;
            } catch (e1) {
              const msg1 = String(e1?.message || '').toLowerCase();
              if (msg1.includes('unknown column') || msg1.includes("doesn't exist")) continue;
              throw e1;
            }
          }
        } catch (e2) {
          const msg2 = String(e2?.message || '').toLowerCase();
          if (msg2.includes('unknown column') || msg2.includes("doesn't exist")) {
            continue;
          }
          throw e2;
        }

        if (Array.isArray(rows)) break;
      }
      if (Array.isArray(rows)) break;
    }

    const list = Array.isArray(rows) ? rows : [];
    const hasMore = list.length > limit;
    const slice = hasMore ? list.slice(0, limit) : list;

    res.json({
      title: 'Sales Orders',
      period,
      offset,
      limit,
      total_count: totalCount,
      has_more: hasMore,
      rows: slice.map((r) => ({
        id: Number(r.id),
        order_no: String(r.order_no ?? ''),
        customer_name: String(r.customer_name ?? ''),
        sales_person: String(r.sales_person ?? ''),
        order_date: r.order_date,
        total: Math.round(Number(r.total || 0) * 100) / 100,
        status_name: String(r.status_name ?? '')
      }))
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/dashboard/kpi/sales/summary?period=today|week|month|last_month|all
router.get('/kpi/sales/summary', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.session?.user?.id;
    const period = parsePeriod(req.query.period);
    const selectedSalesUserIdRaw = req.query.sales_user_id;
    const selectedSalesUserId = selectedSalesUserIdRaw === '' || selectedSalesUserIdRaw == null
      ? null
      : Number(selectedSalesUserIdRaw);

    const canViewAll = await resolveDashboardCanViewAll(userId);

    const effectiveUserId = (canViewAll && Number.isFinite(selectedSalesUserId) && selectedSalesUserId > 0)
      ? selectedSalesUserId
      : (!canViewAll ? userId : null);

    const userFilter = effectiveUserId ? ' AND so.created_by = ?' : '';
    // AR invoices table uses `user_id` (see arInvoices.controller.cjs insert)
    const invUserFilter = effectiveUserId ? ' AND inv.user_id = ?' : '';
    const userParams = effectiveUserId ? [effectiveUserId] : [];

    const salesUsers = canViewAll ? await loadSalesUsersForFilter() : [];

    async function queryWithOptionalIsDeleted({ sqlWithIsDeleted, sqlWithoutIsDeleted, params }) {
      try {
        const [rows] = await db.promise().query(sqlWithIsDeleted, params);
        return rows;
      } catch (e) {
        const msg = String(e?.message || '').toLowerCase();
        if (msg.includes('unknown column') && msg.includes('is_deleted')) {
          const [rows] = await db.promise().query(sqlWithoutIsDeleted, params);
          return rows;
        }
        throw e;
      }
    }

    // For some installs, the soft-delete column is `is_delete` (not `is_deleted`).
    // We try `is_deleted` first, then `is_delete`, and only then fall back.
    async function querySalesOrdersWithDeleteFilter({ sqlBase, params }) {
      const candidates = [
        `${sqlBase} AND (so.is_deleted = 0 OR so.is_deleted IS NULL)`,
        `${sqlBase} AND (so.is_delete = 0 OR so.is_delete IS NULL)`,
      ];
      let lastErr = null;
      for (const sql of candidates) {
        try {
          const [rows] = await db.promise().query(sql, params);
          return rows;
        } catch (e) {
          lastErr = e;
          const msg = String(e?.message || '').toLowerCase();
          if (msg.includes('unknown column') || msg.includes("doesn't exist")) continue;
          throw e;
        }
      }
      // last resort: run without delete filter (better than failing dashboard entirely)
      // eslint-disable-next-line no-console
      console.warn('[DASHBOARD_SALES_SUMMARY] sales_orders delete flag not found; falling back without delete filter');
      const [rows] = await db.promise().query(sqlBase, params);
      return rows;
    }

    // Sales order count (by created_at; fallback to order_date if your data uses that)
    const soRange = rangeSql(period);
    const soDateExpr = 'COALESCE(so.created_at, so.order_date)';
    const soSqlBase = `SELECT COUNT(*) AS cnt
         FROM sales_orders so
        WHERE ${soRange.whereSql.replaceAll('dcol', soDateExpr)}
        ${userFilter}`;
    const soRows = await querySalesOrdersWithDeleteFilter({
      sqlBase: soSqlBase,
      params: [...soRange.params, ...userParams]
    });
    const salesOrderCount = Number(soRows?.[0]?.cnt ?? 0);

    // Sales order total value (base currency) — column name varies by install.
    const soTotalExprs = [
      'so.grand_total',
      'so.total_amount',
      'so.net_total',
      'so.amount_total'
    ];
    let salesOrderTotalValue = 0;
    for (const totalExpr of soTotalExprs) {
      const soValueSqlBase = `SELECT
            COALESCE(SUM(COALESCE(${totalExpr}, 0) * COALESCE(cur.conversion_rate, 1)), 0) AS total_value
           FROM sales_orders so
           LEFT JOIN currency cur ON cur.id = so.currency_id
          WHERE ${soRange.whereSql.replaceAll('dcol', soDateExpr)}
          ${userFilter}`;
      try {
        const soValueRows = await querySalesOrdersWithDeleteFilter({
          sqlBase: soValueSqlBase,
          params: [...soRange.params, ...userParams]
        });
        salesOrderTotalValue = Number(soValueRows?.[0]?.total_value ?? 0);
        break;
      } catch (e1) {
        const msg1 = String(e1?.message || '').toLowerCase();
        if (msg1.includes('unknown column') || msg1.includes("doesn't exist")) {
          continue;
        }
        throw e1;
      }
    }

    // Customer invoices total + highest (by created_at; fallback to invoice_date)
    // Note: table name may differ in your AR module; adjust if needed.
    const invRange = rangeSql(period);
    const invDateExpr = 'COALESCE(inv.created_at, inv.invoice_date)';
    const invSqlBase = `SELECT
          COALESCE(SUM(inv.total * COALESCE(c.conversion_rate, 1)), 0) AS total_value,
          COALESCE(MAX(inv.total * COALESCE(c.conversion_rate, 1)), 0) AS highest_value
         FROM ar_invoices inv
         LEFT JOIN currency c ON c.id = inv.currency_id
         LEFT JOIN status s ON s.id = inv.status_id
        WHERE ${invRange.whereSql.replaceAll('dcol', invDateExpr)}
          AND (s.name IS NULL OR s.name <> 'CANCELLED')
        ${invUserFilter}`;
    const invRows = await queryWithOptionalIsDeleted({
      sqlWithIsDeleted: `${invSqlBase} AND (inv.is_deleted = 0 OR inv.is_deleted IS NULL)`,
      sqlWithoutIsDeleted: invSqlBase,
      params: [...invRange.params, ...userParams]
    });
    const totalInvoiceValue = Number(invRows?.[0]?.total_value ?? 0);
    const highestInvoiceValue = Number(invRows?.[0]?.highest_value ?? 0);

    // company_settings.base_currency is sometimes stored as currency ID; normalize to currency code (e.g. 'AED')
    const [csRows] = await db.promise().query(
      `SELECT cs.base_currency,
              c.name AS currency_code
         FROM company_settings cs
         LEFT JOIN currency c
           ON c.id = cs.base_currency OR c.name = cs.base_currency
        LIMIT 1`
    );
    const currencyCode = csRows?.[0]?.currency_code || csRows?.[0]?.base_currency || 'AED';

    const outCards = [
      {
        key: 'sales_orders_count',
        title: 'Sales Orders',
        value: salesOrderCount,
        value_type: 'count',
        route_path: '/sales/sales-orders'
      },
      {
        key: 'sales_orders_total_value',
        title: 'SO Total Value',
        value: Math.round(salesOrderTotalValue * 100) / 100,
        value_type: 'money',
        route_path: '/sales/sales-orders'
      },
      {
        key: 'invoice_total_value',
        title: 'Invoice Total',
        value: Math.round(totalInvoiceValue * 100) / 100,
        value_type: 'money',
        route_path: '/ar/invoices'
      },
      {
        key: 'invoice_highest_value',
        title: 'Highest Invoice',
        value: Math.round(highestInvoiceValue * 100) / 100,
        value_type: 'money',
        route_path: '/ar/invoices'
      }
    ];
    console.log('[DASHBOARD_SALES_SUMMARY] cards:', outCards.map((c) => c.key).join(', '));

    res.json({
      period,
      currency_code: currencyCode,
      filters: canViewAll ? {
        sales_users: salesUsers,
        selected_sales_user_id: effectiveUserId || null
      } : null,
      cards: outCards
    });
  } catch (e) {
    next(e);
  }
});

// Helper for Operational KPIs
async function getOperationalKpiData(req, options) {
    const userId = req.user?.id || req.session?.user?.id;
    const period = parsePeriod(req.query.period);
    const range = rangeSql(period);
    
    const canViewAll = await resolveDashboardCanViewAll(userId);

    const [roles] = await db.promise().query(
        `SELECT r.name, r.id FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?`,
        [userId]
    );
    const roleIds = roles.map(r => Number(r.id));
    const roleNames = roles.map(r => r.name);
    console.log(`[KPI_DEBUG] User: ${userId}, roleIds: ${JSON.stringify(roleIds)}, roleNames: ${JSON.stringify(roleNames)}, canViewAll: ${canViewAll}`);

    const selectedSalesUserId = req.query.sales_user_id ? Number(req.query.sales_user_id) : null;
    const includeDetails = req.query.details === '1' || req.query.details === 'true';
    const offset = Math.max(0, parseIntParam(req.query.offset, 0));
    const limit = Math.min(200, Math.max(1, parseIntParam(req.query.limit, includeDetails ? 5 : 0)));

    const salesUsers = canViewAll ? await loadSalesUsersForFilter() : [];
    if (canViewAll) console.log(`[KPI_DEBUG] Found ${salesUsers.length} sales users`);

    // Determine filter
    const effectiveUserId = (canViewAll && selectedSalesUserId) ? selectedSalesUserId : (!canViewAll ? userId : null);
    const userFilter = effectiveUserId ? ' AND so.sales_person_id = ?' : '';
    const userParams = effectiveUserId ? [effectiveUserId] : [];

    let countSql = `SELECT COUNT(*) AS cnt FROM sales_orders so WHERE (so.is_deleted = 0 OR so.is_deleted IS NULL) ${userFilter}`;
    // Prefer vendor master for customers (this codebase), and include sales person name.
    const selectSqlVendor = `
        SELECT so.id,
               so.order_no,
               so.order_date,
               COALESCE(NULLIF(v.company_name, ''), v.display_name, CONCAT('Customer #', so.customer_id)) AS customer_name,
               so.grand_total,
               st.name AS status_name,
               COALESCE(u.name, u2.name, 'System') AS sales_person
        FROM sales_orders so
        LEFT JOIN vendor v ON v.id = so.customer_id AND v.company_type_id = '2'
        LEFT JOIN status st ON st.id = so.status_id
        LEFT JOIN \`user\` u ON u.id = so.sales_person_id
        LEFT JOIN \`user\` u2 ON u2.id = so.created_by
        WHERE (so.is_deleted = 0 OR so.is_deleted IS NULL) ${userFilter}
    `;
    const selectSqlCustomer = `
        SELECT so.id,
               so.order_no,
               so.order_date,
               c.display_name AS customer_name,
               so.grand_total,
               st.name AS status_name,
               COALESCE(u.name, u2.name, 'System') AS sales_person
        FROM sales_orders so
        LEFT JOIN customer c ON c.id = so.customer_id
        LEFT JOIN status st ON st.id = so.status_id
        LEFT JOIN \`user\` u ON u.id = so.sales_person_id
        LEFT JOIN \`user\` u2 ON u2.id = so.created_by
        WHERE (so.is_deleted = 0 OR so.is_deleted IS NULL) ${userFilter}
    `;
    const selectSqlCustomers = `
        SELECT so.id,
               so.order_no,
               so.order_date,
               c.display_name AS customer_name,
               so.grand_total,
               st.name AS status_name,
               COALESCE(u.name, u2.name, 'System') AS sales_person
        FROM sales_orders so
        LEFT JOIN customers c ON c.id = so.customer_id
        LEFT JOIN status st ON st.id = so.status_id
        LEFT JOIN \`user\` u ON u.id = so.sales_person_id
        LEFT JOIN \`user\` u2 ON u2.id = so.created_by
        WHERE (so.is_deleted = 0 OR so.is_deleted IS NULL) ${userFilter}
    `;
    const selectSqlNoCustomer = `
        SELECT so.id,
               so.order_no,
               so.order_date,
               CAST(so.customer_id AS CHAR) AS customer_name,
               so.grand_total,
               st.name AS status_name,
               COALESCE(u.name, u2.name, 'System') AS sales_person
        FROM sales_orders so
        LEFT JOIN status st ON st.id = so.status_id
        LEFT JOIN \`user\` u ON u.id = so.sales_person_id
        LEFT JOIN \`user\` u2 ON u2.id = so.created_by
        WHERE (so.is_deleted = 0 OR so.is_deleted IS NULL) ${userFilter}
    `;

    let whereClause = '';
    if (options.statusId) {
        whereClause += ` AND so.status_id = ${options.statusId}`;
    }
    if (Array.isArray(options.statusIds) && options.statusIds.length) {
        const ids = options.statusIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
        if (ids.length) {
            whereClause += ` AND so.status_id IN (${ids.join(',')})`;
        }
    }
    if (options.extraFilter) {
        // If a caller passes an unqualified `id`, qualify it as `so.id` without
        // corrupting other identifiers like `is_deleted` or `sales_order_id`.
        // Also avoid corrupting already-qualified identifiers like `so.id`.
        const safe = String(options.extraFilter).replace(/(^|[^.])\bid\b/g, '$1so.id');
        whereClause += ` AND ${safe}`;
    }
    // Date filtering: allow per-card date expressions (e.g., delivered_at), fall back safely.
    const dateExprs = Array.isArray(options.dateExprs) && options.dateExprs.length
        ? options.dateExprs
        : ['so.created_at'];

    const runWithDateExpr = async (dateExpr) => {
        let wc = whereClause;
        if (period !== 'all') {
            wc += ` AND ${range.whereSql.replaceAll('dcol', dateExpr)}`;
        }

        const [countRows] = await db.promise().query(countSql + wc, userParams);
        let rows = [];

        if (includeDetails) {
            const run = async (sql) => (
              await db.promise().query(
                sql + wc + ` ORDER BY ${dateExpr} DESC LIMIT ? OFFSET ?`,
                [...userParams, limit, offset]
              )
            )[0];
            try {
              rows = await run(selectSqlVendor);
            } catch (e1) {
              const msg1 = String(e1?.message || '').toLowerCase();
              if (msg1.includes("doesn't exist") && (msg1.includes('vendor') || msg1.includes('company_type_id'))) {
                try {
                  rows = await run(selectSqlCustomer);
                } catch (e2) {
                  const msg2 = String(e2?.message || '').toLowerCase();
                  if (msg2.includes("doesn't exist") && msg2.includes('customer')) {
                    try {
                      rows = await run(selectSqlCustomers);
                    } catch {
                      rows = await run(selectSqlNoCustomer);
                    }
                  } else {
                    throw e2;
                  }
                }
              } else if (msg1.includes("doesn't exist") && msg1.includes('customer')) {
                try {
                  rows = await run(selectSqlCustomers);
                } catch {
                  rows = await run(selectSqlNoCustomer);
                }
              } else {
                throw e1;
              }
            }
        }

        return { countRows, rows };
    };

    let finalCountRows = null;
    let finalRows = [];
    for (const dateExpr of dateExprs) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const r = await runWithDateExpr(dateExpr);
            finalCountRows = r.countRows;
            finalRows = r.rows;
            break;
        } catch (e) {
            const msg = String(e?.message || '').toLowerCase();
            if (msg.includes('unknown column') || msg.includes("doesn't exist")) continue;
            throw e;
        }
    }

    // Last resort if all candidates failed
    if (!finalCountRows) {
        const r = await runWithDateExpr('so.created_at');
        finalCountRows = r.countRows;
        finalRows = r.rows;
    }

    const totalCount = Number(finalCountRows?.[0]?.cnt ?? 0);
    const hasMore = includeDetails ? (offset + (finalRows?.length || 0) < totalCount) : false;

    return {
        count: totalCount,
        total_count: totalCount,
        has_more: hasMore,
        rows: finalRows,
        period,
        filters: canViewAll ? {
            sales_users: salesUsers,
            selected_sales_user_id: effectiveUserId || null
        } : null
    };
}

async function resolveStatusIdLike(pattern, fallbackId) {
  try {
    const p = String(pattern || '').toUpperCase();
    if (!p) return fallbackId;
    const [rows] = await db.promise().query(
      `SELECT id FROM status WHERE UPPER(name) LIKE ? ORDER BY id ASC LIMIT 1`,
      [p]
    );
    const id = Number(rows?.[0]?.id);
    return Number.isFinite(id) && id > 0 ? id : fallbackId;
  } catch {
    return fallbackId;
  }
}

// GET /api/dashboard/kpi/operations/pending-accept
router.get('/kpi/operations/pending-accept', requireAuth, async (req, res, next) => {
    try {
        // Interpret as: Approved but not yet Accepted.
        // Resolve Approved status id by name to match each install's status master.
        const approvedStatusId = await resolveStatusIdLike('%APPROV%', 1);
        const data = await getOperationalKpiData(req, { statusId: approvedStatusId });
        res.json({ success: true, total: data.count, total_count: data.total_count, has_more: data.has_more, rows: data.rows, period: data.period, filters: data.filters });
    } catch (e) { next(e); }
});

// GET /api/dashboard/kpi/operations/pending-delivery
router.get('/kpi/operations/pending-delivery', requireAuth, async (req, res, next) => {
    try {
        // Interpret as: Accepted/Dispatched/Partially Dispatched but not yet Delivered/Completed.
        const acceptedId = await resolveStatusIdLike('%ACCEPT%', 13);
        const dispatchedId = await resolveStatusIdLike('%DISPATCH%', 9);
        const partialId = await resolveStatusIdLike('%PARTIALLY%DISPATCH%', 11);
        const deliveredId = await resolveStatusIdLike('%DELIVER%', 12);
        const completedId = await resolveStatusIdLike('%COMPLET%', 10);

        const includeIds = Array.from(new Set([acceptedId, dispatchedId, partialId]))
          .filter((n) => Number.isFinite(n) && n > 0 && n !== deliveredId && n !== completedId);
        const excludeIds = Array.from(new Set([deliveredId, completedId]))
          .filter((n) => Number.isFinite(n) && n > 0);

        const data = await getOperationalKpiData(req, {
            statusIds: includeIds,
            extraFilter: excludeIds.length ? `so.status_id NOT IN (${excludeIds.join(',')})` : null
        });
        res.json({ success: true, total: data.count, total_count: data.total_count, has_more: data.has_more, rows: data.rows, period: data.period, filters: data.filters });
    } catch (e) { next(e); }
});

// GET /api/dashboard/kpi/operations/pending-invoice
router.get('/kpi/operations/pending-invoice', requireAuth, async (req, res, next) => {
    try {
        // Interpret as: Delivered/Completed sales orders that do not yet have a generated invoice.
        const deliveredId = await resolveStatusIdLike('%DELIVER%', 12);
        const completedId = await resolveStatusIdLike('%COMPLET%', 10);
        const includeIds = Array.from(new Set([deliveredId, completedId])).filter((n) => Number.isFinite(n) && n > 0);

        const data = await getOperationalKpiData(req, {
            statusIds: includeIds,
            extraFilter: 'so.id NOT IN (SELECT sales_order_id FROM ar_invoices WHERE sales_order_id IS NOT NULL AND (is_deleted = 0 OR is_deleted IS NULL))',
            dateExprs: ['so.delivered_at', 'so.delivered_date', 'so.completed_at', 'so.updated_at', 'so.created_at']
        });
        res.json({ success: true, total: data.count, total_count: data.total_count, has_more: data.has_more, rows: data.rows, period: data.period, filters: data.filters });
    } catch (e) { next(e); }
});

// GET /api/dashboard/kpi/operations/delivered?period=...&sales_user_id=...&details=1
// Interpreted as: Completed/Delivered sales orders (status_id=15 by default).
router.get('/kpi/operations/delivered', requireAuth, async (req, res, next) => {
  try {
    // Interpret as Delivered/Completed sales orders, filtered by delivered/completed date if present.
    const deliveredId = await resolveStatusIdLike('%DELIVER%', 12);
    const completedId = await resolveStatusIdLike('%COMPLET%', 10);
    const includeIds = Array.from(new Set([deliveredId, completedId])).filter((n) => Number.isFinite(n) && n > 0);
    const data = await getOperationalKpiData(req, {
      statusIds: includeIds,
      dateExprs: ['so.delivered_at', 'so.delivered_date', 'so.completed_at', 'so.updated_at', 'so.created_at']
    });
    res.json({ success: true, total: data.count, total_count: data.total_count, has_more: data.has_more, rows: data.rows, period: data.period, filters: data.filters });
  } catch (e) { next(e); }
});

export default router;

