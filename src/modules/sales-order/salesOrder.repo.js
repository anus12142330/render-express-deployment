export const fetchCompanyPrefix = async (conn, companyId) => {
    const [rows] = await conn.query('SELECT company_prefix FROM company_settings WHERE id = ?', [companyId]);
    return rows[0]?.company_prefix || 'SO';
};

import crypto from 'node:crypto';

const generateSalesOrderUniqId = () => `so_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** Get company prefix and optional sales order number format template (from master). */
export const fetchSalesOrderFormat = async (conn, companyId) => {
    const [rows] = await conn.query(
        'SELECT company_prefix, sales_order_no_format FROM company_settings WHERE id = ?',
        [companyId]
    );
    const prefix = rows[0]?.company_prefix || 'SO';
    const format = rows[0]?.sales_order_no_format?.trim() || null;
    return { prefix, format };
};

export const getSalesOrderHeader = async (conn, { id: inputId, clientId }) => {
    let id = inputId;
    
    // If inputId is a uniqid (string starting with so_), resolve the numeric ID first
    if (typeof inputId === 'string' && inputId.startsWith('so_')) {
        const [idRows] = await conn.query('SELECT id FROM sales_orders WHERE uniqid = ? LIMIT 1', [inputId]);
        if (idRows.length > 0) {
            id = idRows[0].id;
        }
    }

    const [rows] = await conn.query(
        `SELECT so.*, 
                COALESCE(NULLIF(v.company_name, ''), v.display_name) as customer_name, 
                (SELECT vo.tax_registration_number FROM vendor_other vo WHERE vo.vendor_id = v.id LIMIT 1) as tax_no,
                comp.name as company_name, 
                w.warehouse_name as warehouse_name, 
                u.name as sales_person_name,
                s.name as status,
                s.name as status_name,
                s.name as status_label,
                s.bg_colour as status_bg,
                s.colour as status_text_color,
                urb.name as edit_requested_by_name,
                ucomp.name as completed_by_name,
                cur.name as currency_code,
                latest_d.vehicle_no,
                latest_d.driver_name,
                latest_d.dispatched_at,
                udisp.name as dispatched_by_name,
                udeliv.name as delivered_by_name,
                ucr.name as created_by_name,
                (SELECT GROUP_CONCAT(CONCAT(ROUND(qty, 2), ' ', acronyms) SEPARATOR ', ')
                 FROM (
                     SELECT SUM(soi_inner.quantity) as qty, u_inner.acronyms
                     FROM sales_order_items soi_inner
                     JOIN uom_master u_inner ON soi_inner.uom_id = u_inner.id
                     WHERE soi_inner.sales_order_id = ?
                     GROUP BY u_inner.id
                 ) t_sum) as total_quantity
         FROM sales_orders so
         LEFT JOIN vendor v ON so.customer_id = v.id
         LEFT JOIN company_settings comp ON so.company_id = comp.id
         LEFT JOIN warehouses w ON so.warehouse_id = w.id
         LEFT JOIN \`user\` u ON so.sales_person_id = u.id
         LEFT JOIN status s ON so.status_id = s.id
         LEFT JOIN \`user\` urb ON so.edit_requested_by = urb.id
         LEFT JOIN \`user\` ucomp ON so.completed_by = ucomp.id
         LEFT JOIN \`user\` ucr ON so.created_by = ucr.id
         LEFT JOIN \`user\` udeliv ON so.delivered_by = udeliv.id
         LEFT JOIN currency cur ON so.currency_id = cur.id
          LEFT JOIN sales_order_dispatches latest_d ON latest_d.id = (
            SELECT id FROM sales_order_dispatches 
            WHERE sales_order_id = ? 
            ORDER BY dispatched_at DESC LIMIT 1
         )
         LEFT JOIN \`user\` udisp ON latest_d.dispatched_by = udisp.id
         WHERE (so.id = ? OR so.uniqid = ?)
           AND COALESCE(so.is_deleted, 0) = 0`,
        [id, id, id, inputId]
    );
    return rows[0];
};

export const getSalesOrderItems = async (conn, { salesOrderId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT soi.*, p.product_name,
         (SELECT pd.packing_alias FROM product_details pd WHERE pd.product_id = soi.product_id ORDER BY pd.id ASC LIMIT 1) AS product_packing_alias,
         u.acronyms as uom_name, t.tax_name,
         (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = soi.product_id ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) AS thumbnail_url
         FROM sales_order_items soi
         LEFT JOIN products p ON soi.product_id = p.id
         LEFT JOIN uom_master u ON soi.uom_id = u.id
         LEFT JOIN taxes t ON soi.tax_id = t.id
         WHERE soi.sales_order_id = ?`,
        [salesOrderId]
    );
    return rows;
};

export const getSalesOrderAttachments = async (conn, { salesOrderId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT * FROM sales_order_attachments WHERE sales_order_id = ?`,
        [salesOrderId]
    );
    return rows;
};

export const getSalesOrderDispatches = async (conn, { salesOrderId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT d.*, u.name as dispatched_by_name 
         FROM sales_order_dispatches d
         LEFT JOIN \`user\` u ON d.dispatched_by = u.id
         WHERE d.sales_order_id = ?
         ORDER BY d.dispatched_at DESC`,
        [salesOrderId]
    );
    return rows;
};

/** Inventory rows linked to this sales order (e.g. SALES_ORDER_IN_TRANSIT on approve). */
export const getSalesOrderInventoryTransactions = async (conn, { salesOrderId }) => {
    const [rows] = await conn.query(
        `SELECT
            it.id,
            it.txn_date,
            it.movement,
            it.txn_type,
            it.source_type,
            it.source_id,
            it.source_line_id,
            it.sales_order_id,
            it.product_id,
            it.warehouse_id,
            it.batch_id,
            it.qty,
            it.unit_cost,
            it.amount,
            it.currency_id,
            it.exchange_rate,
            it.foreign_amount,
            it.total_amount,
            it.uom_id,
            it.movement_type_id,
            p.product_name,
            w.warehouse_name,
            um.name AS uom_name,
            um.acronyms AS uom_acronyms,
            ib.batch_no,
            cur.name AS currency_code
         FROM inventory_transactions it
         JOIN products p ON p.id = it.product_id
         JOIN warehouses w ON w.id = it.warehouse_id
         LEFT JOIN uom_master um ON um.id = it.uom_id
         LEFT JOIN inventory_batches ib ON ib.id = it.batch_id
         LEFT JOIN currency cur ON cur.id = it.currency_id
         WHERE (it.is_deleted = 0 OR it.is_deleted IS NULL)
           AND (
                it.sales_order_id = ?
             OR (it.source_type = 'SALES_ORDER' AND it.source_id = ?)
             OR (
                  it.source_type = 'SALES_DISPATCH'
                  AND EXISTS (
                      SELECT 1 FROM sales_order_dispatches sod
                      WHERE sod.id = it.source_id AND sod.sales_order_id = ?
                  )
                )
           )
         ORDER BY it.id ASC`,
        [salesOrderId, salesOrderId, salesOrderId]
    );
    return rows;
};

export const getSalesOrderReturns = async (conn, { salesOrderId }) => {
    const [rows] = await conn.query(
        `SELECT cr.*, s.name as status_name, s.bg_colour as color_code, s.colour as status_text_color,
                qc_s.name as qc_status_name, qc_s.bg_colour as qc_color_code, qc_s.colour as qc_status_text_color,
                qcm.name as qc_manager_name
         FROM cargo_returns cr
         LEFT JOIN status s ON cr.status_id = s.id
         LEFT JOIN status qc_s ON cr.qc_status_id = qc_s.id
         LEFT JOIN \`user\` qcm ON cr.qc_manager_id = qcm.id
         WHERE cr.sales_order_id = ?
         ORDER BY cr.id DESC`,
        [salesOrderId]
    );
    return rows;
};

export const getReturnLines = async (conn, { cargoReturnId }) => {
    const [rows] = await conn.query(
        `SELECT crl.*, soi.uom_id, u.acronyms as uom_name
         FROM cargo_return_lines crl
         LEFT JOIN sales_order_items soi ON crl.sales_order_item_id = soi.id
         LEFT JOIN uom_master u ON soi.uom_id = u.id
         WHERE crl.cargo_return_id = ?
         ORDER BY crl.id ASC`,
        [cargoReturnId]
    );
    return rows;
};


export const getDispatchById = async (conn, { id }) => {
    const [rows] = await conn.query(
        `SELECT * FROM sales_order_dispatches WHERE id = ?`,
        [id]
    );
    return rows[0];
};

export const getDispatchItems = async (conn, { dispatchId }) => {
    const [rows] = await conn.query(
        `SELECT di.*, p.product_name, u.acronyms as uom_name, soi.product_id as product_sku,
                ab.bill_number as bill_no, COALESCE(abb.container_no, ab.container_no) as container_no, GROUP_CONCAT(DISTINCT abb.batch_no SEPARATOR ', ') as batch_no
         FROM sales_order_dispatch_items di
         JOIN sales_order_items soi ON di.sales_order_item_id = soi.id
         LEFT JOIN products p ON soi.product_id = p.id
         LEFT JOIN uom_master u ON soi.uom_id = u.id
         LEFT JOIN ap_bill_lines abl ON di.ap_bill_line_id = abl.id
         LEFT JOIN ap_bills ab ON abl.bill_id = ab.id
         LEFT JOIN ap_bill_line_batches abb ON abb.bill_line_id = abl.id
         WHERE di.dispatch_id = ?
         GROUP BY di.id`,
        [dispatchId]
    );
    return rows;
};

export const getSalesOrderApproval = async (conn, { salesOrderId, clientId }) => {
    return null;
};

export const getSalesOrderAudit = async (conn, { salesOrderId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT h.action, h.details as payload_json, h.user_id as action_by, h.created_at, u.name as action_by_name
         FROM history h
         LEFT JOIN \`user\` u ON h.user_id = u.id
         WHERE h.module = 'sales_order' AND h.module_id = ? 
         ORDER BY h.created_at DESC`,
        [salesOrderId]
    );
    return rows;
};

export const insertSalesOrder = async (conn, data) => {
    const {
        company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_no, order_date, status_id,
        subtotal, tax_total, grand_total, created_by, terms_conditions, sales_person_id
    } = data;

    const uniqid = data?.uniqid || generateSalesOrderUniqId();

    const [res] = await conn.query(
        `INSERT INTO sales_orders 
    (uniqid, company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_no, order_date, status_id, subtotal, tax_total, grand_total, created_by, updated_by, terms_conditions, sales_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uniqid, company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_no, order_date, status_id, subtotal, tax_total, grand_total, created_by, created_by, terms_conditions, sales_person_id]
    );
    return res.insertId;
};

export const updateSalesOrderHeader = async (conn, data) => {
    const {
        id, client_id, company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_date,
        subtotal, tax_total, grand_total, updated_by, terms_conditions, sales_person_id
    } = data;

    await conn.query(
        `UPDATE sales_orders 
     SET company_id=?, customer_id=?, warehouse_id=?, billing_address=?, shipping_address=?, currency_id=?, tax_mode=?, order_date=?, subtotal=?, tax_total=?, grand_total=?, updated_by=?, terms_conditions=?, sales_person_id=?, edit_request_status = NULL, edit_requested_by = NULL 
     WHERE id=?`,
        [company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_date, subtotal, tax_total, grand_total, updated_by, terms_conditions, sales_person_id, id]
    );
};

export const replaceSalesOrderItems = async (conn, { salesOrderId, clientId, items }) => {
    // Delete existing
    await conn.query(`DELETE FROM sales_order_items WHERE sales_order_id = ?`, [salesOrderId]);

    if (items.length === 0) return;

    // Bulk insert (tax_id from normalized item - ensure we pass through)
    const values = items.map(i => {
        const taxId = i.tax_id ?? i.taxId;
        const taxIdVal = (taxId != null && taxId !== '') ? (Number(taxId) || null) : null;
        return [
            salesOrderId, i.product_id, i.description,
            i.quantity, i.ordered_quantity || i.quantity || 0, i.dispatched_quantity || 0,
            i.uom_id,
            i.unit_price, i.discount_type || 'PERCENTAGE', i.discount_rate || 0, i.discount_amount || 0, i.tax_rate, taxIdVal, i.line_subtotal, i.line_tax, i.line_total
        ];
    });

    await conn.query(
        `INSERT INTO sales_order_items 
    (sales_order_id, product_id, description, quantity, ordered_quantity, dispatched_quantity, uom_id, unit_price, discount_type, discount_rate, discount_amount, tax_rate, tax_id, line_subtotal, line_tax, line_total)
    VALUES ?`,
        [values]
    );
};

export const updateItemDispatchedQuantity = async (conn, { id, dispatched_quantity }) => {
    await conn.query(
        `UPDATE sales_order_items SET dispatched_quantity = ? WHERE id = ?`,
        [dispatched_quantity, id]
    );
};

export const insertDispatchHeader = async (conn, data) => {
    const { sales_order_id, vehicle_no, driver_name, dispatched_by, comments, ap_bill_id } = data;
    const [res] = await conn.query(
        `INSERT INTO sales_order_dispatches (sales_order_id, ap_bill_id, vehicle_no, driver_name, dispatched_by, comments, dispatched_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [sales_order_id, ap_bill_id ?? null, vehicle_no, driver_name, dispatched_by, comments || null]
    );
    return res.insertId;
};

export const updateDispatchHeader = async (conn, data) => {
    const { id, vehicle_no, driver_name, comments, ap_bill_id } = data;
    const params = [vehicle_no, driver_name, comments || null];
    let sql = `UPDATE sales_order_dispatches SET vehicle_no = ?, driver_name = ?, comments = ?`;
    if (ap_bill_id !== undefined) {
        sql += `, ap_bill_id = ?`;
        params.push(ap_bill_id);
    }
    sql += ` WHERE id = ?`;
    params.push(id);
    await conn.query(sql, params);
};

export const insertDispatchItems = async (conn, items) => {
    // items = [[dispatch_id, sales_order_item_id, ap_bill_line_id, quantity], ...]
    if (!items.length) return;
    await conn.query(
        `INSERT INTO sales_order_dispatch_items (dispatch_id, sales_order_item_id, ap_bill_line_id, quantity)
         VALUES ?`,
        [items]
    );
};

export const deleteDispatchItems = async (conn, { dispatchId }) => {
    await conn.query(`DELETE FROM sales_order_dispatch_items WHERE dispatch_id = ?`, [dispatchId]);
};

export const deleteDispatchHeader = async (conn, { id }) => {
    await conn.query(`DELETE FROM sales_order_dispatches WHERE id = ?`, [id]);
};
export const insertAttachments = async (conn, filesRowData) => {
    // filesRowData = [[sales_order_id, dispatch_id, scope, original_name, name, type, size, path, uploaded_by, created_at], ...]
    if (!filesRowData || !filesRowData.length) return;
    const rows = filesRowData.map((row) => [
        row[0],
        row[1] ?? null,
        row[2] ?? 'FILE',
        String(row[3] ?? ''),
        String(row[4] ?? ''),
        String(row[5] ?? 'application/octet-stream'),
        Number(row[6]) || 0,
        String(row[7] ?? ''),
        row[8] ?? null,
        row[9] ?? new Date()
    ]);
    await conn.query(
        `INSERT INTO sales_order_attachments
    (sales_order_id, dispatch_id, scope, file_original_name, file_name, file_type, file_size, file_path, uploaded_by, created_at)
    VALUES ?`,
        [rows]
    );
};

export const getAttachmentById = async (conn, { attachmentId }) => {
    const [rows] = await conn.query('SELECT * FROM sales_order_attachments WHERE id = ?', [attachmentId]);
    return rows[0];
};

export const deleteAttachment = async (conn, { attachmentId }) => {
    await conn.query('DELETE FROM sales_order_attachments WHERE id = ?', [attachmentId]);
};

export const insertApproval = async (conn, data) => {
    // approvals table removed
};

export const insertAudit = async (conn, data) => {
    const { sales_order_id, action, payload_json, action_by } = data;
    const details = (payload_json && typeof payload_json === 'object')
        ? JSON.stringify(payload_json)
        : (payload_json || null);

    await conn.query(
        `INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)`,
        ['sales_order', sales_order_id, action_by, action, details]
    );
};

export const listSalesOrders = async (conn, { clientId, page, pageSize, search, status_id, company_id, customer_id, sales_person_id, date_from, date_to, edit_request_status, created_by, filter_own_user_id, exclude_with_ar_invoice, exclude_with_cargo_return }) => {
    const offset = (page - 1) * pageSize;
    const conditions = ['COALESCE(so.is_deleted, 0) = 0'];
    const params = [];

    if (exclude_with_ar_invoice) {
        conditions.push('so.id NOT IN (SELECT sales_order_id FROM ar_invoices WHERE sales_order_id IS NOT NULL)');
    }
    if (exclude_with_cargo_return) {
        conditions.push(
            'NOT EXISTS (SELECT 1 FROM cargo_returns cr WHERE cr.sales_order_id = so.id)'
        );
    }
    // Own records: show where logged-in user is creator OR sales person. Super Admin / view_all do not set this.
    if (filter_own_user_id != null && filter_own_user_id !== '') {
        conditions.push('(so.created_by = ? OR so.sales_person_id = ?)');
        params.push(filter_own_user_id, filter_own_user_id);
    } else if (created_by != null && created_by !== '') {
        conditions.push('so.created_by = ?');
        params.push(created_by);
    }
    if (sales_person_id) {
        conditions.push('so.sales_person_id = ?');
        params.push(sales_person_id);
    }
    if (search) {
        conditions.push('(so.order_no LIKE ? OR v.display_name LIKE ? OR p.product_name LIKE ? OR comp.name LIKE ? OR u.name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status_id) {
        const statusStr = String(status_id);
        if (statusStr.includes(',')) {
            const ids = statusStr.split(',').map(s => s.trim()).filter(Boolean);
            if (ids.length > 0) {
                conditions.push(`so.status_id IN (${ids.map(() => '?').join(',')})`);
                params.push(...ids);
            }
        } else {
            conditions.push('so.status_id = ?');
            params.push(status_id);
        }
    }
    if (company_id) {
        conditions.push('so.company_id = ?');
        params.push(company_id);
    }
    if (customer_id) {
        conditions.push('so.customer_id = ?');
        params.push(customer_id);
    }
    if (date_from) {
        conditions.push('so.order_date >= ?');
        params.push(date_from);
    }
    if (date_to) {
        conditions.push('so.order_date <= ?');
        params.push(date_to);
    }
    if (edit_request_status) {
        conditions.push('so.edit_request_status = ?');
        params.push(edit_request_status);
    }

    const where = conditions.length ? conditions.join(' AND ') : '1=1';

    // Count first
    const countSql = search
        ? `
    SELECT COUNT(*) as total FROM (
      SELECT so.id
      FROM sales_orders so
      LEFT JOIN vendor v ON so.customer_id = v.id
      LEFT JOIN company_settings comp ON so.company_id = comp.id
      LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
      LEFT JOIN products p ON soi.product_id = p.id
      LEFT JOIN user u ON so.sales_person_id = u.id
      WHERE ${where}
      GROUP BY so.id
    ) AS sub
  `
        : `
    SELECT COUNT(*) as total
    FROM sales_orders so
    LEFT JOIN vendor v ON so.customer_id = v.id
    WHERE ${where}
  `;
    const [countRows] = await conn.query(countSql, params);
    const total = countRows[0].total;

    const sql = `
    SELECT so.*, COALESCE(NULLIF(v.company_name, ''), v.display_name) as customer_name, v.company_name as customer_company,
           comp.name as company_name,
           s.name as status, s.name as status_name, s.bg_colour as color_code, s.bg_colour as status_bg, s.colour as status_text_color,
           u.name as sales_person_name, u_creator.name as created_by_name,
           cur.name as currency_code, urb.name as edit_requested_by_name,
           (SELECT GROUP_CONCAT(DISTINCT p2.product_name SEPARATOR ', ') 
            FROM sales_order_items soi2 
            JOIN products p2 ON soi2.product_id = p2.id 
            WHERE soi2.sales_order_id = so.id) as product_names,
           (SELECT GROUP_CONCAT(DISTINCT pi.thumbnail_path SEPARATOR ',')
            FROM sales_order_items soi3
            JOIN product_images pi ON soi3.product_id = pi.product_id
            WHERE soi3.sales_order_id = so.id) as product_images,
           uom_agg.total_quantity,
           (SELECT COALESCE(SUM(soi4.dispatched_quantity), 0) FROM sales_order_items soi4 WHERE soi4.sales_order_id = so.id) as total_dispatched_quantity,
           (SELECT COALESCE(SUM(soi5.quantity), 0) FROM sales_order_items soi5 WHERE soi5.sales_order_id = so.id) as total_ordered_quantity
    FROM sales_orders so
    LEFT JOIN vendor v ON so.customer_id = v.id
    LEFT JOIN company_settings comp ON so.company_id = comp.id
    LEFT JOIN status s ON so.status_id = s.id
    LEFT JOIN \`user\` u ON so.sales_person_id = u.id
    LEFT JOIN \`user\` u_creator ON so.created_by = u_creator.id
    LEFT JOIN currency cur ON so.currency_id = cur.id
    LEFT JOIN \`user\` urb ON so.edit_requested_by = urb.id
    LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
    LEFT JOIN products p ON soi.product_id = p.id
    LEFT JOIN (
        SELECT t.sales_order_id,
               GROUP_CONCAT(CONCAT(ROUND(t.qty, 2), ' ', t.acronyms) SEPARATOR ', ') as total_quantity
        FROM (
            SELECT soi_u.sales_order_id, SUM(soi_u.quantity) as qty, um.acronyms
            FROM sales_order_items soi_u
            JOIN uom_master um ON soi_u.uom_id = um.id
            GROUP BY soi_u.sales_order_id, um.id
        ) t
        GROUP BY t.sales_order_id
    ) uom_agg ON so.id = uom_agg.sales_order_id
    WHERE ${where}
    GROUP BY so.id
    ORDER BY so.created_at DESC
    LIMIT ? OFFSET ?
  `;

    const [rows] = await conn.query(sql, [...params, Number(pageSize), Number(offset)]);

    return { rows, total };
};

export const listApprovalQueue = async (conn, { clientId, page, pageSize, search }) => {
    const offset = (page - 1) * pageSize;
    const params = [8]; // 8 = Submitted
    let searchClause = '';

    if (search) {
        searchClause = 'AND (so.order_no LIKE ? OR v.display_name LIKE ? OR p.product_name LIKE ? OR comp.name LIKE ? OR u.name LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const sql = `
    SELECT so.*, COALESCE(NULLIF(v.company_name, ''), v.display_name) as customer_name, comp.name as company_name, s.name as status_name,
           GROUP_CONCAT(DISTINCT p.product_name SEPARATOR ', ') as product_names
    FROM sales_orders so
    JOIN vendor v ON so.customer_id = v.id
    JOIN company_settings comp ON so.company_id = comp.id
    JOIN status s ON so.status_id = s.id
    LEFT JOIN user u ON so.sales_person_id = u.id
    LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
    LEFT JOIN products p ON soi.product_id = p.id
    WHERE so.status_id = ? AND COALESCE(so.is_deleted, 0) = 0 ${searchClause}
    GROUP BY so.id
    ORDER BY so.updated_at ASC
    LIMIT ? OFFSET ?
  `;

    const [rows] = await conn.query(sql, [...params, Number(pageSize), Number(offset)]);

    const countSql = `
     SELECT COUNT(*) as total 
     FROM sales_orders so 
     JOIN vendor v ON so.customer_id = v.id
     LEFT JOIN user u ON so.sales_person_id = u.id
     WHERE so.status_id = 8 AND COALESCE(so.is_deleted, 0) = 0 ${searchClause}
  `;
    const [countRows] = await conn.query(countSql, params);

    return { rows, total: countRows[0].total };
};

// ---- Dispatch vehicle/driver (separate from fleet/driver masters) ----
const DISPATCH_VD_TABLE = 'sales_dispatch_vehicle_driver';

/** Distinct vehicle names ever used for dispatch for this client */
export const getDispatchVehicles = async (conn, { clientId }) => {
    if (clientId == null || clientId === '') return [];
    const [rows] = await conn.query(
        `SELECT DISTINCT vehicle_name FROM ${DISPATCH_VD_TABLE} WHERE client_id = ? ORDER BY vehicle_name`,
        [clientId]
    );
    return rows.map(r => ({ vehicle_name: r.vehicle_name }));
};

/** Distinct driver names for a given vehicle (and client) */
export const getDispatchDriversByVehicle = async (conn, { clientId, vehicleName }) => {
    if (clientId == null || clientId === '') return [];
    const [rows] = await conn.query(
        `SELECT DISTINCT driver_name FROM ${DISPATCH_VD_TABLE} WHERE client_id = ? AND vehicle_name = ? ORDER BY driver_name`,
        [clientId, vehicleName || '']
    );
    return rows.map(r => ({ driver_name: r.driver_name }));
};

/** Save vehicle+driver pair for next time (ignore if already exists) */
export const upsertDispatchVehicleDriver = async (conn, { clientId, vehicleName, driverName }) => {
    if (!clientId || !vehicleName?.trim() || !driverName?.trim()) return;
    const v = String(vehicleName).trim();
    const d = String(driverName).trim();
    await conn.query(
        `INSERT IGNORE INTO ${DISPATCH_VD_TABLE} (client_id, vehicle_name, driver_name) VALUES (?, ?, ?)`,
        [clientId, v, d]
    );
};

/**
 * Get dispatch batch/bill info for Record Shipment: warehouse, and per product all purchase bills (bill_date, batch_no, allocated_quantity, remaining_quantity).
 * Only returns bills with remaining allocation > 0.
 * Calculation: remaining = ap_bill_line.quantity - SUM(dispatched_quantity from sales_order_dispatch_items).
 */
export const getDispatchBatchInfo = async (conn, { salesOrderId }) => {
    const [[header]] = await conn.query(
        `SELECT so.warehouse_id, w.warehouse_name
         FROM sales_orders so
         LEFT JOIN warehouses w ON w.id = so.warehouse_id
         WHERE so.id = ?
           AND COALESCE(so.is_deleted, 0) = 0`,
        [salesOrderId]
    );
    if (!header) return null;
    const warehouse_name = header.warehouse_name || '';

    const [orderItems] = await conn.query(
        `SELECT soi.id as sales_order_item_id, soi.product_id, soi.quantity as ordered_quantity,
                p.product_name
         FROM sales_order_items soi
         LEFT JOIN products p ON p.id = soi.product_id
         WHERE soi.sales_order_id = ?`,
        [salesOrderId]
    );
    if (!orderItems?.length) return { warehouse_id: header.warehouse_id, warehouse_name, dispatching_time: new Date(), items: [] };

    const itemsWithBatches = [];
    for (const row of orderItems) {
        const productId = row.product_id;

        // Fetch all AP bill lines for this product that still have remaining quantity
        const sql = `
            SELECT 
                abl.id as ap_bill_line_id,
                ab.bill_date,
                ab.bill_number,
                COALESCE(abb.container_no, ab.container_no) as container_no,
                abb.batch_no,
                ab.warehouse_id,
                w.warehouse_name,
                abl.quantity as allocated_quantity,
                COALESCE((
                    SELECT SUM(sodi.quantity)
                    FROM sales_order_dispatch_items sodi
                    WHERE sodi.ap_bill_line_id = abl.id
                ), 0) as used_quantity,
                isb.qty_on_hand as current_stock_on_hand
            FROM ap_bill_lines abl
            JOIN ap_bills ab ON ab.id = abl.bill_id
            LEFT JOIN warehouses w ON w.id = ab.warehouse_id
            LEFT JOIN ap_bill_line_batches abb ON abb.bill_line_id = abl.id
            LEFT JOIN inventory_stock_batches isb ON isb.batch_id = abb.batch_id AND isb.warehouse_id = ab.warehouse_id
            WHERE abl.product_id = ?
            ORDER BY ab.bill_date DESC
        `;

        const [batchRows] = await conn.query(sql, [productId]);
        const batches = (batchRows || [])
            .map(r => {
                const remainingAlloc = Number(r.allocated_quantity || 0) - Number(r.used_quantity || 0);
                const currentStock = Number(r.current_stock_on_hand || 0);
                // The actual dispatchable quantity is the minimum of what was allocated from the PO 
                // and what is physically present in the warehouse.
                const finalRemaining = Math.min(remainingAlloc, currentStock);

                return {
                    ap_bill_line_id: r.ap_bill_line_id,
                    bill_date: r.bill_date,
                    bill_no: r.bill_number || '—',
                    container_no: r.container_no || '—',
                    batch_no: r.batch_no || '—',
                    warehouse_id: r.warehouse_id,
                    warehouse_name: r.warehouse_name || '—',
                    allocated_quantity: Number(r.allocated_quantity || 0),
                    remaining_quantity: finalRemaining
                };
            })
            .filter(b => b.remaining_quantity > 0.0001);

        itemsWithBatches.push({
            sales_order_item_id: row.sales_order_item_id,
            product_id: productId,
            product_name: row.product_name || '',
            ordered_quantity: Number(row.ordered_quantity || 0),
            batches
        });
    }

    return {
        warehouse_id: header.warehouse_id,
        warehouse_name,
        dispatching_time: new Date(),
        items: itemsWithBatches
    };
};
