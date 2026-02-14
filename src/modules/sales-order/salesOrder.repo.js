export const fetchCompanyPrefix = async (conn, companyId) => {
    const [rows] = await conn.query('SELECT company_prefix FROM company_settings WHERE id = ?', [companyId]);
    return rows[0]?.company_prefix || 'SO';
};

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

export const getSalesOrderHeader = async (conn, { id, clientId }) => {
    const [rows] = await conn.query(
        `SELECT so.*, 
                v.display_name as customer_name, 
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
                ucr.name as created_by_name,
                uom_sum.summary as total_quantity
         FROM sales_orders so
         LEFT JOIN vendor v ON so.customer_id = v.id
         LEFT JOIN company_settings comp ON so.company_id = comp.id
         LEFT JOIN warehouses w ON so.warehouse_id = w.id
         LEFT JOIN \`user\` u ON so.sales_person_id = u.id
         LEFT JOIN status s ON so.status_id = s.id
         LEFT JOIN \`user\` urb ON so.edit_requested_by = urb.id
         LEFT JOIN \`user\` ucomp ON so.completed_by = ucomp.id
         LEFT JOIN \`user\` ucr ON so.created_by = ucr.id
         LEFT JOIN currency cur ON so.currency_id = cur.id
         LEFT JOIN (
            SELECT * FROM sales_order_dispatches 
            WHERE sales_order_id = ? 
            ORDER BY dispatched_at DESC LIMIT 1
         ) latest_d ON so.id = latest_d.sales_order_id
         LEFT JOIN \`user\` udisp ON latest_d.dispatched_by = udisp.id
         LEFT JOIN (
            SELECT sales_order_id, GROUP_CONCAT(CONCAT(qty, ' ', acronyms) SEPARATOR ', ') as summary
            FROM (
                SELECT soi_inner.sales_order_id, (SUM(soi_inner.quantity) + 0) as qty, u_inner.acronyms
                FROM sales_order_items soi_inner
                JOIN uom_master u_inner ON soi_inner.uom_id = u_inner.id
                GROUP BY soi_inner.sales_order_id, u_inner.id
            ) t1
            GROUP BY sales_order_id
         ) uom_sum ON so.id = uom_sum.sales_order_id
         WHERE so.id = ? AND so.client_id = ?`,
        [id, id, clientId]
    );
    return rows[0];
};

export const getSalesOrderItems = async (conn, { salesOrderId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT soi.*, p.product_name, u.acronyms as uom_name, t.tax_name,
         (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = soi.product_id ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) AS thumbnail_url
         FROM sales_order_items soi
         LEFT JOIN products p ON soi.product_id = p.id
         LEFT JOIN uom_master u ON soi.uom_id = u.id
         LEFT JOIN taxes t ON soi.tax_id = t.id
         WHERE soi.sales_order_id = ? AND soi.client_id = ?`,
        [salesOrderId, clientId]
    );
    return rows;
};

export const getSalesOrderAttachments = async (conn, { salesOrderId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT * FROM sales_order_attachments WHERE sales_order_id = ? AND client_id = ?`,
        [salesOrderId, clientId]
    );
    return rows;
};

export const getSalesOrderDispatches = async (conn, { salesOrderId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT d.*, u.name as dispatched_by_name 
         FROM sales_order_dispatches d
         LEFT JOIN \`user\` u ON d.dispatched_by = u.id
         WHERE d.sales_order_id = ? AND d.client_id = ?
         ORDER BY d.dispatched_at DESC`,
        [salesOrderId, clientId]
    );
    return rows;
};

export const getDispatchById = async (conn, { id, clientId }) => {
    const [rows] = await conn.query(
        `SELECT * FROM sales_order_dispatches WHERE id = ? AND client_id = ?`,
        [id, clientId]
    );
    return rows[0];
};

export const getDispatchItems = async (conn, { dispatchId, clientId }) => {
    const [rows] = await conn.query(
        `SELECT di.*, p.product_name, u.acronyms as uom_name, soi.product_id as product_sku
         FROM sales_order_dispatch_items di
         JOIN sales_order_items soi ON di.sales_order_item_id = soi.id
         LEFT JOIN products p ON soi.product_id = p.id
         LEFT JOIN uom_master u ON soi.uom_id = u.id
         WHERE di.dispatch_id = ? AND di.client_id = ?`,
        [dispatchId, clientId]
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
        client_id, company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_no, order_date, status_id,
        subtotal, tax_total, grand_total, created_by, terms_conditions, sales_person_id
    } = data;

    const [res] = await conn.query(
        `INSERT INTO sales_orders 
    (client_id, company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_no, order_date, status_id, subtotal, tax_total, grand_total, created_by, updated_by, terms_conditions, sales_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [client_id, company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_no, order_date, status_id, subtotal, tax_total, grand_total, created_by, created_by, terms_conditions, sales_person_id]
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
     WHERE id=? AND client_id=?`,
        [company_id, customer_id, warehouse_id, billing_address, shipping_address, currency_id, tax_mode, order_date, subtotal, tax_total, grand_total, updated_by, terms_conditions, sales_person_id, id, client_id]
    );
};

export const replaceSalesOrderItems = async (conn, { salesOrderId, clientId, items }) => {
    // Delete existing
    await conn.query(`DELETE FROM sales_order_items WHERE sales_order_id = ? AND client_id = ?`, [salesOrderId, clientId]);

    if (items.length === 0) return;

    // Bulk insert (tax_id from normalized item - ensure we pass through)
    const values = items.map(i => {
        const taxId = i.tax_id ?? i.taxId;
        const taxIdVal = (taxId != null && taxId !== '') ? (Number(taxId) || null) : null;
        return [
            clientId, salesOrderId, i.product_id, i.description,
            i.quantity, i.ordered_quantity || i.quantity || 0, i.dispatched_quantity || 0,
            i.uom_id,
            i.unit_price, i.discount_type || 'PERCENTAGE', i.discount_rate || 0, i.discount_amount || 0, i.tax_rate, taxIdVal, i.line_subtotal, i.line_tax, i.line_total
        ];
    });

    await conn.query(
        `INSERT INTO sales_order_items 
    (client_id, sales_order_id, product_id, description, quantity, ordered_quantity, dispatched_quantity, uom_id, unit_price, discount_type, discount_rate, discount_amount, tax_rate, tax_id, line_subtotal, line_tax, line_total)
    VALUES ?`,
        [values]
    );
};

export const updateItemDispatchedQuantity = async (conn, { id, dispatched_quantity, clientId }) => {
    await conn.query(
        `UPDATE sales_order_items SET dispatched_quantity = ? WHERE id = ? AND client_id = ?`,
        [dispatched_quantity, id, clientId]
    );
};

export const insertDispatchHeader = async (conn, data) => {
    const { client_id, sales_order_id, vehicle_no, driver_name, dispatched_by } = data;
    const [res] = await conn.query(
        `INSERT INTO sales_order_dispatches (client_id, sales_order_id, vehicle_no, driver_name, dispatched_by, dispatched_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [client_id, sales_order_id, vehicle_no, driver_name, dispatched_by]
    );
    return res.insertId;
};

export const updateDispatchHeader = async (conn, data) => {
    const { id, vehicle_no, driver_name, client_id } = data;
    await conn.query(
        `UPDATE sales_order_dispatches SET vehicle_no = ?, driver_name = ? WHERE id = ? AND client_id = ?`,
        [vehicle_no, driver_name, id, client_id]
    );
};

export const insertDispatchItems = async (conn, items) => {
    // items = [[client_id, dispatch_id, sales_order_item_id, quantity], ...]
    if (!items.length) return;
    await conn.query(
        `INSERT INTO sales_order_dispatch_items (client_id, dispatch_id, sales_order_item_id, quantity)
         VALUES ?`,
        [items]
    );
};

export const deleteDispatchItems = async (conn, { dispatchId, clientId }) => {
    await conn.query(`DELETE FROM sales_order_dispatch_items WHERE dispatch_id = ? AND client_id = ?`, [dispatchId, clientId]);
};

export const deleteDispatchHeader = async (conn, { id, clientId }) => {
    await conn.query(`DELETE FROM sales_order_dispatches WHERE id = ? AND client_id = ?`, [id, clientId]);
};

export const insertAttachments = async (conn, filesRowData) => {
    // filesRowData = [[client_id, sales_order_id, dispatch_id, scope, original_name, name, type, size, path, uploaded_by, created_at], ...]
    if (!filesRowData.length) return;
    await conn.query(
        `INSERT INTO sales_order_attachments
    (client_id, sales_order_id, dispatch_id, scope, file_original_name, file_name, file_type, file_size, file_path, uploaded_by, created_at)
    VALUES ?`,
        [filesRowData]
    );
};

export const getAttachmentById = async (conn, { attachmentId, clientId }) => {
    const [rows] = await conn.query('SELECT * FROM sales_order_attachments WHERE id = ? AND client_id = ?', [attachmentId, clientId]);
    return rows[0];
};

export const deleteAttachment = async (conn, { attachmentId, clientId }) => {
    await conn.query('DELETE FROM sales_order_attachments WHERE id = ? AND client_id = ?', [attachmentId, clientId]);
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

export const listSalesOrders = async (conn, { clientId, page, pageSize, search, status_id, company_id, customer_id, date_from, date_to, edit_request_status, created_by }) => {
    const offset = (page - 1) * pageSize;
    const conditions = ['so.client_id = ?'];
    const params = [clientId];

    if (created_by != null && created_by !== '') {
        conditions.push('so.created_by = ?');
        params.push(created_by);
    }
    if (search) {
        conditions.push('(so.order_no LIKE ? OR v.display_name LIKE ? OR p.product_name LIKE ? OR comp.name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
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

    const where = conditions.join(' AND ');

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
    SELECT so.*, v.display_name as customer_name, v.company_name as customer_company,
           comp.name as company_name,
           s.name as status, s.name as status_name, s.bg_colour as color_code, s.bg_colour as status_bg, s.colour as status_text_color,
           u.name as sales_person_name, u_creator.name as created_by_name,
           cur.name as currency_code, urb.name as edit_requested_by_name,
           (SELECT GROUP_CONCAT(DISTINCT p2.product_name SEPARATOR ', ') 
            FROM sales_order_items soi2 
            JOIN products p2 ON soi2.product_id = p2.id 
            WHERE soi2.sales_order_id = so.id) as product_names,
           uom_sum.summary as total_quantity
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
        SELECT sales_order_id, GROUP_CONCAT(CONCAT(qty, ' ', acronyms) SEPARATOR ', ') as summary
        FROM (
            SELECT soi_inner.sales_order_id, (SUM(soi_inner.quantity) + 0) as qty, u_inner.acronyms
            FROM sales_order_items soi_inner
            JOIN uom_master u_inner ON soi_inner.uom_id = u_inner.id
            GROUP BY soi_inner.sales_order_id, u_inner.id
        ) t1
        GROUP BY sales_order_id
    ) uom_sum ON so.id = uom_sum.sales_order_id
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
    const params = [clientId, 8]; // 8 = Submitted
    let searchClause = '';

    if (search) {
        searchClause = 'AND (so.order_no LIKE ? OR v.display_name LIKE ? OR p.product_name LIKE ? OR comp.name LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const sql = `
    SELECT so.*, v.display_name as customer_name, comp.name as company_name, s.name as status_name,
           GROUP_CONCAT(DISTINCT p.product_name SEPARATOR ', ') as product_names
    FROM sales_orders so
    JOIN vendor v ON so.customer_id = v.id
    JOIN company_settings comp ON so.company_id = comp.id
    JOIN status s ON so.status_id = s.id
    LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
    LEFT JOIN products p ON soi.product_id = p.id
    WHERE so.client_id = ? AND so.status_id = ? ${searchClause}
    GROUP BY so.id
    ORDER BY so.updated_at ASC
    LIMIT ? OFFSET ?
  `;

    const [rows] = await conn.query(sql, [...params, Number(pageSize), Number(offset)]);

    const countSql = `
     SELECT COUNT(*) as total 
     FROM sales_orders so 
     JOIN vendor v ON so.customer_id = v.id
     WHERE so.client_id = ? AND so.status_id = 8 ${searchClause}
  `;
    const [countRows] = await conn.query(countSql, params);

    return { rows, total: countRows[0].total };
};
