import db from '../../../db.js';

/**
 * @param {string|number|undefined|null} statusIdParam - single id or comma-separated, e.g. "3" or "3,8"
 * @returns {number[]|null}
 */
export function parseCargoReturnStatusIds(statusIdParam) {
    if (statusIdParam == null || statusIdParam === '') return null;
    const ids = String(statusIdParam)
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n));
    return ids.length ? ids : null;
}

/**
 * @param {object} params
 * @param {number} params.clientId
 * @param {number} params.page
 * @param {number} params.pageSize
 * @param {string} [params.search]
 * @param {number|null} [params.filterOwnUserId] - if set, only rows where created_by = this
 * @param {number[]|null} [params.statusIds] - filter by cr.status_id IN (...)
 * @param {number[]|null} [params.qcStatusIds] - filter by cr.qc_status_id IN (...)
 * @param {string} [params.dateFrom] - YYYY-MM-DD
 * @param {string} [params.dateTo] - YYYY-MM-DD
 */
export async function countCargoReturns({ clientId, search, filterOwnUserId, statusIds, qcStatusIds, salesQc, dateFrom, dateTo }) {
    const terms = [];
    const args = [clientId];

    if (search && String(search).trim()) {
        const q = `%${String(search).trim()}%`;
        terms.push(
            `(cr.return_no LIKE ? OR so.order_no LIKE ? OR COALESCE(NULLIF(v.company_name,''), v.display_name, '') LIKE ? OR COALESCE(comp.name,'') LIKE ? OR EXISTS (SELECT 1 FROM cargo_return_lines lq WHERE lq.cargo_return_id = cr.id AND COALESCE(lq.product_name,'') LIKE ?))`
        );
        args.push(q, q, q, q, q);
    }
    if (filterOwnUserId != null) {
        terms.push('cr.created_by = ?');
        args.push(filterOwnUserId);
    }
    if (statusIds && statusIds.length) {
        terms.push(`cr.status_id IN (${statusIds.map(() => '?').join(',')})`);
        args.push(...statusIds);
    }
    if (qcStatusIds && qcStatusIds.length) {
        terms.push(`COALESCE(sqc.qc_status_id, cr.qc_status_id) IN (${qcStatusIds.map(() => '?').join(',')})`);
        args.push(...qcStatusIds);
    }
    if (salesQc === 'only') {
        terms.push(`sqc.cargo_return_id IS NOT NULL`);
    } else if (salesQc === 'none') {
        terms.push(`sqc.cargo_return_id IS NULL`);
    }

    if (dateFrom) {
        terms.push('DATE(cr.document_date) >= ?');
        args.push(dateFrom);
    }
    if (dateTo) {
        terms.push('DATE(cr.document_date) <= ?');
        args.push(dateTo);
    }

    const where = terms.length ? `AND ${terms.join(' AND ')}` : '';
    const [rows] = await db.promise().query(
        `SELECT COUNT(*) AS cnt
         FROM cargo_returns cr
         LEFT JOIN sales_qc sqc ON sqc.cargo_return_id = cr.id
         JOIN sales_orders so ON so.id = cr.sales_order_id
         LEFT JOIN vendor v ON so.customer_id = v.id
         LEFT JOIN company_settings comp ON so.company_id = comp.id
         WHERE cr.client_id = ?
           AND COALESCE(so.is_deleted, 0) = 0
           ${where}`,
        args
    );
    return Number(rows[0]?.cnt ?? 0);
}

/**
 * @param {object} params
 * @param {number} params.clientId
 * @param {number} params.page
 * @param {number} params.pageSize
 * @param {string} [params.search]
 * @param {number|null} [params.filterOwnUserId]
 * @param {number[]|null} [params.statusIds] - filter by cr.status_id IN (...)
 * @param {number[]|null} [params.qcStatusIds] - filter by cr.qc_status_id IN (...)
 * @param {string} [params.dateFrom] - YYYY-MM-DD
 * @param {string} [params.dateTo] - YYYY-MM-DD
 */
export async function listCargoReturns({ clientId, page, pageSize, search, filterOwnUserId, statusIds, qcStatusIds, salesQc, dateFrom, dateTo }) {
    const terms = [];
    const args = [clientId];

    if (search && String(search).trim()) {
        const q = `%${String(search).trim()}%`;
        terms.push(
            `(cr.return_no LIKE ? OR so.order_no LIKE ? OR COALESCE(NULLIF(v.company_name,''), v.display_name, '') LIKE ? OR COALESCE(comp.name,'') LIKE ? OR EXISTS (SELECT 1 FROM cargo_return_lines lq WHERE lq.cargo_return_id = cr.id AND COALESCE(lq.product_name,'') LIKE ?))`
        );
        args.push(q, q, q, q, q);
    }
    if (filterOwnUserId != null) {
        terms.push('cr.created_by = ?');
        args.push(filterOwnUserId);
    }
    if (statusIds && statusIds.length) {
        terms.push(`cr.status_id IN (${statusIds.map(() => '?').join(',')})`);
        args.push(...statusIds);
    }
    if (qcStatusIds && qcStatusIds.length) {
        terms.push(`COALESCE(sqc.qc_status_id, cr.qc_status_id) IN (${qcStatusIds.map(() => '?').join(',')})`);
        args.push(...qcStatusIds);
    }
    if (salesQc === 'only') {
        terms.push(`sqc.cargo_return_id IS NOT NULL`);
    } else if (salesQc === 'none') {
        terms.push(`sqc.cargo_return_id IS NULL`);
    }

    if (dateFrom) {
        terms.push('DATE(cr.document_date) >= ?');
        args.push(dateFrom);
    }
    if (dateTo) {
        terms.push('DATE(cr.document_date) <= ?');
        args.push(dateTo);
    }

    const where = terms.length ? `AND ${terms.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    args.push(pageSize, offset);

    const [rows] = await db.promise().query(
        `SELECT
            cr.id,
            cr.return_no,
            cr.sales_order_id,
            cr.document_date,
            cr.created_at,
            cr.status_id,
            COALESCE(sqc.qc_status_id, cr.qc_status_id) AS qc_status_id,
            cr_st.name AS status_name,
            cr_st.bg_colour AS color_code,
            cr_st.colour AS status_text_color,
            qc_st.name AS qc_status_name,
            qc_st.bg_colour AS qc_color_code,
            qc_st.colour AS qc_status_text_color,

            so.order_no,
            COALESCE(NULLIF(v.company_name,''), v.display_name) AS customer_name,
            comp.name AS company_name,
            so.grand_total,
            cur.name AS currency_code,
            (SELECT COUNT(*) FROM cargo_return_lines l WHERE l.cargo_return_id = cr.id) AS line_count,
            (SELECT COALESCE(SUM(COALESCE(soi.quantity, 0)), 0)
             FROM cargo_return_lines l
             LEFT JOIN sales_order_items soi ON soi.id = l.sales_order_item_id
             WHERE l.cargo_return_id = cr.id
            ) AS total_ordered_qty,
            (SELECT COALESCE(SUM(COALESCE(l.dispatched_qty, 0)), 0)
             FROM cargo_return_lines l
             WHERE l.cargo_return_id = cr.id
            ) AS total_dispatched_qty,
            (SELECT COALESCE(SUM(return_qty), 0) FROM cargo_return_lines l WHERE l.cargo_return_id = cr.id) AS total_return_qty,
            (SELECT SUBSTRING(GROUP_CONCAT(
                CONCAT(
                    COALESCE(NULLIF(TRIM(l.product_name), ''), '—'),
                    ' (',
                    FORMAT(COALESCE(l.return_qty, 0), 2),
                    ')'
                )
                ORDER BY l.line_no ASC, l.id ASC SEPARATOR ' · '
            ), 1, 2000)
             FROM cargo_return_lines l WHERE l.cargo_return_id = cr.id
            ) AS returned_items_summary
         FROM cargo_returns cr
          JOIN sales_orders so ON so.id = cr.sales_order_id
          LEFT JOIN sales_qc sqc ON sqc.cargo_return_id = cr.id
          LEFT JOIN status cr_st ON cr_st.id = cr.status_id
          LEFT JOIN status qc_st ON qc_st.id = COALESCE(sqc.qc_status_id, cr.qc_status_id)
          LEFT JOIN vendor v ON so.customer_id = v.id

         LEFT JOIN company_settings comp ON so.company_id = comp.id
         LEFT JOIN currency cur ON so.currency_id = cur.id
         WHERE cr.client_id = ?
           AND COALESCE(so.is_deleted, 0) = 0
           ${where}
         ORDER BY cr.id DESC
         LIMIT ? OFFSET ?`,
        args
    );
    return rows;
}

export async function getCargoReturnHeaderById({ id, clientId }) {
    const [rows] = await db.promise().query(
        `SELECT
            cr.id,
            cr.client_id,
            cr.sales_order_id,
            cr.return_no,
            cr.document_date,
            cr.created_at,
            cr.status_id,
            COALESCE(sqc.qc_status_id, cr.qc_status_id) AS qc_status_id,
            cr.notes,
            cr.return_source,
            cr.ar_invoice_id,
            cr.return_reason_id,
            rr.name AS return_reason_name,
            cr.return_to_store,
            cr.return_to_store_date,
            cr.refund_type,
            cr.created_by,
            COALESCE(sqc.qc_decision, cr.qc_decision) AS qc_decision,
            COALESCE(sqc.qc_comment, cr.qc_comment) AS qc_comment,
            COALESCE(sqc.qc_manager_id, cr.qc_manager_id) AS qc_manager_id,
            COALESCE(sqc.qc_inventory_pending, cr.qc_inventory_pending) AS qc_inventory_pending,
            sqc.manager_approval_comment,
            qcm.name AS qc_manager_name,
            cr_st.name AS status_name,
            cr_st.bg_colour AS color_code,
            cr_st.colour AS status_text_color,
            qc_st.name AS qc_status_name,
            qc_st.bg_colour AS qc_color_code,
            qc_st.colour AS qc_status_text_color,

            so.order_no,
            so.status_id AS order_status_id,
            so_st.name AS order_status_name,
            COALESCE(NULLIF(v.company_name,''), v.display_name) AS customer_name,
            comp.name AS company_name,
            so.grand_total,
            cur.name AS currency_code,
            u.name AS created_by_name
         FROM cargo_returns cr
          JOIN sales_orders so ON so.id = cr.sales_order_id
          LEFT JOIN sales_qc sqc ON sqc.cargo_return_id = cr.id
          LEFT JOIN status cr_st ON cr_st.id = cr.status_id
          LEFT JOIN status qc_st ON qc_st.id = COALESCE(sqc.qc_status_id, cr.qc_status_id)
          LEFT JOIN status so_st ON so_st.id = so.status_id
          LEFT JOIN \`user\` u ON u.id = cr.created_by
          LEFT JOIN \`user\` qcm ON qcm.id = COALESCE(sqc.qc_manager_id, cr.qc_manager_id)
         LEFT JOIN cargo_return_reasons rr ON rr.id = cr.return_reason_id



         LEFT JOIN vendor v ON so.customer_id = v.id
         LEFT JOIN company_settings comp ON so.company_id = comp.id
         LEFT JOIN currency cur ON so.currency_id = cur.id
         WHERE cr.id = ?
           AND cr.client_id = ?
           AND COALESCE(so.is_deleted, 0) = 0`,
        [id, clientId]
    );
    return rows[0] || null;
}

export async function getCargoReturnAudit({ cargoReturnId }) {
    const [rows] = await db.promise().query(
        `SELECT h.action, h.details as payload_json, h.user_id as action_by, h.created_at, u.name as action_by_name
         FROM history h
         LEFT JOIN \`user\` u ON h.user_id = u.id
         WHERE h.module = 'cargo_return' AND h.module_id = ?
         ORDER BY h.created_at DESC`,
        [cargoReturnId]
    );
    return rows;
}

export async function insertHistory(conn, { module, moduleId, userId, action, details }) {
    await conn.query(
        `INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)`,
        [module, moduleId, userId ?? null, action, details != null ? JSON.stringify(details) : null]
    );
}

/** @param {{ id: number, clientId: number, fromStatusIds: number[], toStatusId: number, toQcStatusId?: number }} p */
export async function updateCargoReturnStatusId(p) {
    const { id, clientId, fromStatusIds, toStatusId, toQcStatusId } = p;
    const [rows] = await db
        .promise()
        .query(`SELECT status_id FROM cargo_returns WHERE id = ? AND client_id = ?`, [id, clientId]);
    if (!rows.length) throw new Error('Cargo return not found');
    const cur = Number(rows[0].status_id);
    const allowed = fromStatusIds.map(Number);
    if (!allowed.includes(cur)) {
        throw new Error('Invalid status transition for this cargo return');
    }

    const setFields = ['status_id = ?'];
    const args = [toStatusId];

    let finalQcStatusId = toQcStatusId;
    if (finalQcStatusId === undefined) {
        const ts = Number(toStatusId);
        if (ts === 8 || ts === 1) {
            finalQcStatusId = 4; // Pending QC
        }
    }

    if (finalQcStatusId !== undefined) {
        setFields.push('qc_status_id = ?');
        args.push(finalQcStatusId);
    }

    args.push(id, clientId);

    await db.promise().query(
        `UPDATE cargo_returns SET ${setFields.join(', ')} WHERE id = ? AND client_id = ?`,
        args
    );
}



export async function getCargoReturnLinesByHeaderId(cargoReturnId) {
    const [rows] = await db.promise().query(
        `SELECT crl.id, crl.cargo_return_id, crl.dispatch_id, crl.dispatch_item_id, crl.sales_order_item_id, crl.product_name,
                crl.dispatched_qty, crl.return_qty, crl.accepted_qty, crl.rejected_qty,
                crl.pending_accepted_qty, crl.pending_rejected_qty, crl.line_no,
                soi.quantity AS ordered_qty,
                u.acronyms AS uom_name,
                pd.packing_alias AS packing_alias
         FROM cargo_return_lines crl
         LEFT JOIN sales_order_items soi ON soi.id = crl.sales_order_item_id
         LEFT JOIN uom_master u ON soi.uom_id = u.id
         LEFT JOIN product_details pd ON pd.id = (
            SELECT id FROM product_details pd2
            WHERE pd2.product_id = soi.product_id
            ORDER BY pd2.id ASC
            LIMIT 1
         )
         WHERE crl.cargo_return_id = ?
         ORDER BY crl.line_no ASC, crl.id ASC`,
        [cargoReturnId]
    );
    return rows;
}

export async function getCargoReturnAttachmentsByCargoReturnId(cargoReturnId) {
    const [rows] = await db.promise().query(
        `SELECT id, cargo_return_id, scope, file_original_name, file_name, file_type, file_size, file_path, uploaded_by, created_at
         FROM cargo_return_attachments
         WHERE cargo_return_id = ?
         ORDER BY id ASC`,
        [cargoReturnId]
    );
    return rows;
}

export async function getCargoReturnAttachmentById(attachmentId) {
    const [rows] = await db.promise().query(`SELECT * FROM cargo_return_attachments WHERE id = ?`, [attachmentId]);
    return rows[0] || null;
}

export async function insertCargoReturnAttachments(conn, rows) {
    if (!rows?.length) return;
    const values = rows.map((r) => [
        r.cargo_return_id,
        r.scope != null ? String(r.scope) : 'RETURN',
        String(r.file_original_name ?? ''),
        String(r.file_name ?? ''),
        r.file_type != null ? String(r.file_type) : null,
        r.file_size != null ? Number(r.file_size) : null,
        String(r.file_path ?? ''),
        r.uploaded_by != null ? Number(r.uploaded_by) : null
    ]);
    await conn.query(
        `INSERT INTO cargo_return_attachments
          (cargo_return_id, scope, file_original_name, file_name, file_type, file_size, file_path, uploaded_by)
         VALUES ?`,
        [values]
    );
}

export async function deleteCargoReturnAttachmentById(conn, attachmentId) {
    await conn.query(`DELETE FROM cargo_return_attachments WHERE id = ?`, [attachmentId]);
}
