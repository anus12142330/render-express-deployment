// server/src/modules/inventory/inventory.service.js
// Unified inventory service - uses SINGLE stock table and SINGLE transaction table

const { pool } = require('../../db/tx.cjs');

/**
 * Get available batches for a product in a warehouse
 */
async function getAvailableBatches(productId, warehouseId) {
    const [rows] = await pool.query(`
        SELECT 
            ib.id as batch_id,
            ib.batch_no,
            ib.mfg_date,
            ib.exp_date,
            isb.qty_on_hand,
            isb.unit_cost
        FROM inventory_stock_batches isb
        JOIN inventory_batches ib ON ib.id = isb.batch_id
        WHERE isb.product_id = ? AND isb.warehouse_id = ? AND isb.qty_on_hand > 0
        ORDER BY ib.exp_date ASC, ib.mfg_date ASC, ib.id ASC
    `, [productId, warehouseId]);
    return rows;
}

/**
 * Get batch stock with filters, pagination, and search
 */
async function getBatchStock(filters = {}, offset = 0, limit = 100) {
    let sql = `
        SELECT 
            isb.*,
            ib.batch_no,
            ib.mfg_date,
            ib.exp_date,
            p.product_name,
            p.hscode,
            w.warehouse_name,
            c.name as currency_name,
            c.name as currency_code,
            um.name as uom_name,
            um.acronyms as uom_acronyms
        FROM inventory_stock_batches isb
        JOIN inventory_batches ib ON ib.id = isb.batch_id
        JOIN products p ON p.id = isb.product_id
        JOIN warehouses w ON w.id = isb.warehouse_id
        LEFT JOIN currency c ON c.id = isb.currency_id
        LEFT JOIN uom_master um ON um.id = isb.uom_id
        WHERE 1=1
    `;
    const params = [];

    if (filters.product_id) {
        sql += ' AND isb.product_id = ?';
        params.push(filters.product_id);
    }
    if (filters.warehouse_id) {
        sql += ' AND isb.warehouse_id = ?';
        params.push(filters.warehouse_id);
    }
    if (filters.batch_id) {
        sql += ' AND isb.batch_id = ?';
        params.push(filters.batch_id);
    }

    // Add search filter
    if (filters.search) {
        sql += ` AND (
            p.product_name LIKE ? OR
            ib.batch_no LIKE ? OR
            w.warehouse_name LIKE ? OR
            p.hscode LIKE ?
        )`;
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Build count query separately
    const whereClause = sql.substring(sql.indexOf('WHERE'));
    const countSql = `
        SELECT COUNT(*) as total
        FROM inventory_stock_batches isb
        JOIN inventory_batches ib ON ib.id = isb.batch_id
        JOIN products p ON p.id = isb.product_id
        JOIN warehouses w ON w.id = isb.warehouse_id
        LEFT JOIN currency c ON c.id = isb.currency_id
        LEFT JOIN uom_master um ON um.id = isb.uom_id
        ${whereClause}
    `;
    
    // Count params (same as main query params, but without LIMIT/OFFSET)
    const countParams = [...params];
    const [countResult] = await pool.query(countSql, countParams);
    const total = countResult[0]?.total || 0;

    // Add ordering and pagination to main query
    sql += ' ORDER BY ib.exp_date ASC, ib.mfg_date ASC, isb.id ASC';
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pool.query(sql, params);
    return { rows, total };
}

/**
 * Get batches near expiry
 */
async function getNearExpiryBatches(days = 30, warehouseId = null) {
    let sql = `
        SELECT 
            isb.*,
            ib.batch_no,
            ib.mfg_date,
            ib.exp_date,
            p.product_name,
            w.warehouse_name,
            DATEDIFF(ib.exp_date, CURDATE()) as days_to_expiry
        FROM inventory_stock_batches isb
        JOIN inventory_batches ib ON ib.id = isb.batch_id
        JOIN products p ON p.id = isb.product_id
        JOIN warehouses w ON w.id = isb.warehouse_id
        WHERE ib.exp_date IS NOT NULL
          AND ib.exp_date >= CURDATE()
          AND ib.exp_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
          AND isb.qty_on_hand > 0
    `;
    const params = [days];

    if (warehouseId) {
        sql += ' AND isb.warehouse_id = ?';
        params.push(warehouseId);
    }

    sql += ' ORDER BY ib.exp_date ASC';

    const [rows] = await pool.query(sql, params);
    return rows;
}

/**
 * Get inventory transactions with filters, pagination, and search
 */
async function getInventoryTransactions(filters = {}, offset = 0, limit = 100) {
    let sql = `
        SELECT 
            it.*,
            COALESCE(it.total_amount, it.amount) as local_amount,
            ib.batch_no,
            p.product_name,
            p.hscode,
            w.warehouse_name,
            c.name as currency_name,
            c.name as currency_code,
            um.name as uom_name,
            um.acronyms as uom_acronyms
        FROM inventory_transactions it
        LEFT JOIN inventory_batches ib ON ib.id = it.batch_id
        JOIN products p ON p.id = it.product_id
        JOIN warehouses w ON w.id = it.warehouse_id
        LEFT JOIN currency c ON c.id = it.currency_id
        LEFT JOIN uom_master um ON um.id = it.uom_id
        WHERE 1=1
        AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
    `;
    const params = [];

    if (filters.source_type) {
        sql += ' AND it.source_type = ?';
        params.push(filters.source_type);
    }
    if (filters.source_id) {
        sql += ' AND it.source_id = ?';
        params.push(filters.source_id);
    }
    if (filters.product_id) {
        sql += ' AND it.product_id = ?';
        params.push(filters.product_id);
    }
    if (filters.warehouse_id) {
        sql += ' AND it.warehouse_id = ?';
        params.push(filters.warehouse_id);
    }
    if (filters.batch_id) {
        sql += ' AND it.batch_id = ?';
        params.push(filters.batch_id);
    }
    if (filters.qc_posting_type) {
        sql += ' AND it.qc_posting_type = ?';
        params.push(filters.qc_posting_type);
    }
    if (filters.from) {
        sql += ' AND it.txn_date >= ?';
        params.push(filters.from);
    }
    if (filters.to) {
        sql += ' AND it.txn_date <= ?';
        params.push(filters.to);
    }

    // Add search filter
    if (filters.search) {
        sql += ` AND (
            p.product_name LIKE ? OR
            ib.batch_no LIKE ? OR
            w.warehouse_name LIKE ? OR
            p.hscode LIKE ? OR
            it.txn_type LIKE ? OR
            it.source_type LIKE ?
        )`;
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Build count query separately
    const whereClause = sql.substring(sql.indexOf('WHERE'));
    const countSql = `
        SELECT COUNT(*) as total
        FROM inventory_transactions it
        LEFT JOIN inventory_batches ib ON ib.id = it.batch_id
        JOIN products p ON p.id = it.product_id
        JOIN warehouses w ON w.id = it.warehouse_id
        LEFT JOIN currency c ON c.id = it.currency_id
        LEFT JOIN uom_master um ON um.id = it.uom_id
        ${whereClause}
    `;
    
    // Count params (same as main query params, but without LIMIT/OFFSET)
    const countParams = [...params];
    const [countResult] = await pool.query(countSql, countParams);
    const total = countResult[0]?.total || 0;

    // Add ordering and pagination to main query
    sql += ' ORDER BY it.txn_date DESC, it.id DESC';
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pool.query(sql, params);
    return { rows, total };
}

/**
 * Upsert inventory batch (create if not exists)
 */
async function upsertBatch(conn, productId, batchNo, mfgDate, expDate, notes = null) {
    // Check if batch exists
    const [existing] = await conn.query(`
        SELECT id FROM inventory_batches 
        WHERE product_id = ? AND batch_no = ?
    `, [productId, batchNo]);

    if (existing.length > 0) {
        // Update existing batch (only update dates, notes column doesn't exist in table)
        await conn.query(`
            UPDATE inventory_batches 
            SET mfg_date = ?, exp_date = ?, notes = ?, updated_at = NOW()
            WHERE id = ?
        `, [mfgDate, expDate, notes, existing[0].id]);
        return existing[0].id;
    } else {
        // Create new batch
        const [result] = await conn.query(`
            INSERT INTO inventory_batches (product_id, batch_no, mfg_date, exp_date, notes)
            VALUES (?, ?, ?, ?, ?)
        `, [productId, batchNo, mfgDate, expDate, notes]);
        return result.insertId;
    }
}

/**
 * Update inventory stock (weighted average cost for IN, direct reduction for OUT)
 */
async function updateInventoryStock(conn, productId, warehouseId, batchId, qtyChange, unitCost, isIn, currencyId = null, uomId = null) {
    // Check if stock record exists
    const [existing] = await conn.query(`
        SELECT id, qty_on_hand, unit_cost 
        FROM inventory_stock_batches 
        WHERE product_id = ? AND warehouse_id = ? AND batch_id = ?
    `, [productId, warehouseId, batchId]);

    if (existing.length > 0) {
        const oldQty = parseFloat(existing[0].qty_on_hand);
        const oldCost = parseFloat(existing[0].unit_cost);
        const newQty = parseFloat(qtyChange);
        const newCost = parseFloat(unitCost);

        if (isIn) {
            // Weighted average cost
            const totalQty = oldQty + newQty;
            const weightedCost = totalQty > 0 
                ? ((oldQty * oldCost) + (newQty * newCost)) / totalQty 
                : newCost;

            await conn.query(`
                UPDATE inventory_stock_batches 
                SET qty_on_hand = qty_on_hand + ?, unit_cost = ?, 
                    currency_id = COALESCE(?, currency_id), 
                    uom_id = COALESCE(?, uom_id),
                    updated_at = NOW()
                WHERE id = ?
            `, [newQty, weightedCost, currencyId, uomId, existing[0].id]);
        } else {
            // OUT movement - direct reduction
            if (oldQty < newQty) {
                throw new Error(`Insufficient stock. Available: ${oldQty}, Required: ${newQty}`);
            }
            await conn.query(`
                UPDATE inventory_stock_batches 
                SET qty_on_hand = qty_on_hand - ?, updated_at = NOW()
                WHERE id = ?
            `, [newQty, existing[0].id]);
        }
    } else {
        if (isIn) {
            // Create new stock record for IN movement
            await conn.query(`
                INSERT INTO inventory_stock_batches 
                (product_id, warehouse_id, batch_id, qty_on_hand, unit_cost, currency_id, uom_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [productId, warehouseId, batchId, qtyChange, unitCost, currencyId, uomId]);
        } else {
            throw new Error(`Stock record not found for batch ${batchId} in warehouse ${warehouseId}`);
        }
    }
}

/**
 * Insert inventory transaction (unified table)
 */
async function insertInventoryTransaction(conn, params) {
    const {
        txn_date,
        movement,
        txn_type,
        source_type,
        source_id,
        source_line_id = null,
        product_id,
        warehouse_id,
        batch_id = null,
        qty,
        unit_cost,
        currency_id = null,
        exchange_rate = null,
        foreign_amount = null,
        total_amount = null,
        uom_id = null,
        movement_type_id = 1 // Default to 1 (REGULAR_IN). See movement_types table: 1=REGULAR_IN, 2=REGULAR_OUT, 3=IN_TRANSIT, 4=TRANSIT_OUT, 5=DISCARD
    } = params;

    const amount = parseFloat(qty) * parseFloat(unit_cost);
    
    // foreign_amount = actual currency amount (transaction currency)
    // total_amount = converted amount (AED)
    const finalForeignAmount = foreign_amount !== null 
        ? parseFloat(foreign_amount) 
        : amount; // Default to transaction currency amount
    
    const finalTotalAmount = total_amount !== null 
        ? parseFloat(total_amount) 
        : (exchange_rate && exchange_rate > 0 ? amount * parseFloat(exchange_rate) : amount); // Convert to AED if exchange_rate exists

    const [result] = await conn.query(`
        INSERT INTO inventory_transactions 
        (txn_date, movement, txn_type, source_type, source_id, source_line_id, 
         product_id, warehouse_id, batch_id, qty, unit_cost, amount,
         currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [txn_date, movement, txn_type, source_type, source_id, source_line_id,
        product_id, warehouse_id, batch_id, qty, unit_cost, amount,
        currency_id, exchange_rate, finalForeignAmount, finalTotalAmount, uom_id, movement_type_id]);

    return result.insertId;
}

/**
 * Validate batch stock availability
 */
async function validateBatchStock(conn, allocations, warehouseId) {
    for (const alloc of allocations) {
        const [rows] = await conn.query(`
            SELECT qty_on_hand 
            FROM inventory_stock_batches 
            WHERE batch_id = ? AND warehouse_id = ? AND product_id = ?
        `, [alloc.batch_id, warehouseId, alloc.product_id]);

        if (rows.length === 0) {
            throw new Error(`Batch ${alloc.batch_id} not found in warehouse ${warehouseId}`);
        }

        const availableQty = parseFloat(rows[0].qty_on_hand);
        const requiredQty = parseFloat(alloc.quantity);

        if (availableQty < requiredQty) {
            throw new Error(`Insufficient stock for batch ${alloc.batch_id}. Required: ${requiredQty}, Available: ${availableQty}`);
        }
    }
}

/**
 * Allocate batches using FIFO (First In First Out)
 */
async function allocateFIFO(conn, productId, warehouseId, requiredQty) {
    const batches = await getAvailableBatches(productId, warehouseId);
    const allocations = [];
    let remainingQty = parseFloat(requiredQty);

    for (const batch of batches) {
        if (remainingQty <= 0) break;

        const availableQty = parseFloat(batch.qty_on_hand);
        if (availableQty <= 0) continue;

        const allocatedQty = Math.min(remainingQty, availableQty);
        allocations.push({
            batch_id: batch.batch_id,
            batch_no: batch.batch_no,
            quantity: allocatedQty,
            unit_cost: parseFloat(batch.unit_cost),
            exp_date: batch.exp_date
        });

        remainingQty -= allocatedQty;
    }

    if (remainingQty > 0) {
        throw new Error(`Insufficient stock. Required: ${requiredQty}, Available: ${requiredQty - remainingQty}`);
    }

    return allocations;
}

/**
 * Allocate batches using FEFO (First Expiry First Out)
 */
async function allocateFEFO(conn, productId, warehouseId, requiredQty) {
    // FEFO sorts by expiry date first, then by batch_id
    const [batches] = await conn.query(`
        SELECT 
            ib.id as batch_id,
            ib.batch_no,
            ib.mfg_date,
            ib.exp_date,
            isb.qty_on_hand,
            isb.unit_cost
        FROM inventory_stock_batches isb
        JOIN inventory_batches ib ON ib.id = isb.batch_id
        WHERE isb.product_id = ? AND isb.warehouse_id = ? AND isb.qty_on_hand > 0
        ORDER BY 
            CASE WHEN ib.exp_date IS NULL THEN 1 ELSE 0 END,
            ib.exp_date ASC,
            ib.id ASC
    `, [productId, warehouseId]);

    const allocations = [];
    let remainingQty = parseFloat(requiredQty);

    for (const batch of batches) {
        if (remainingQty <= 0) break;

        const availableQty = parseFloat(batch.qty_on_hand);
        if (availableQty <= 0) continue;

        const allocatedQty = Math.min(remainingQty, availableQty);
        allocations.push({
            batch_id: batch.batch_id,
            batch_no: batch.batch_no,
            quantity: allocatedQty,
            unit_cost: parseFloat(batch.unit_cost),
            exp_date: batch.exp_date
        });

        remainingQty -= allocatedQty;
    }

    if (remainingQty > 0) {
        throw new Error(`Insufficient stock. Required: ${requiredQty}, Available: ${requiredQty - remainingQty}`);
    }

    return allocations;
}

/**
 * Get all batches for dropdown filter (distinct batches from inventory_transactions)
 */
async function getAllBatches() {
    const [rows] = await pool.query(`
        SELECT DISTINCT 
            ib.id,
            ib.batch_no
        FROM inventory_transactions it
        INNER JOIN inventory_batches ib ON ib.id = it.batch_id
        WHERE it.batch_id IS NOT NULL
          AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
        ORDER BY ib.batch_no ASC
    `);
    return rows;
}

module.exports = {
    getAvailableBatches,
    getBatchStock,
    getNearExpiryBatches,
    getInventoryTransactions,
    getAllBatches,
    upsertBatch,
    updateInventoryStock,
    insertInventoryTransaction,
    validateBatchStock,
    allocateFIFO,
    allocateFEFO
};

