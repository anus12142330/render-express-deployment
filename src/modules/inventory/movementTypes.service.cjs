// server/src/modules/inventory/movementTypes.service.cjs
// Movement Types Service - handles movement type lookups and stock calculations

/**
 * Get movement type by code
 */
async function getMovementTypeByCode(conn, code) {
    const [rows] = await conn.query(`
        SELECT * FROM movement_types WHERE code = ? AND is_active = 1 LIMIT 1
    `, [code]);
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Get movement type by ID
 */
async function getMovementTypeById(conn, id) {
    const [rows] = await conn.query(`
        SELECT * FROM movement_types WHERE id = ? AND is_active = 1 LIMIT 1
    `, [id]);
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Get all active movement types
 */
async function getAllMovementTypes(conn) {
    const [rows] = await conn.query(`
        SELECT * FROM movement_types WHERE is_active = 1 ORDER BY sort_order, name
    `);
    return rows || [];
}

/**
 * Calculate stock on hand considering transit stock
 * Formula: Stock on Hand = Regular Stock + Transit Stock IN - Transit Stock OUT - Regular Stock OUT - Discard
 */
async function calculateStockOnHand(conn, productId, warehouseId, batchId = null) {
    let whereClause = 'product_id = ? AND warehouse_id = ?';
    const params = [productId, warehouseId];
    
    if (batchId) {
        whereClause += ' AND batch_id = ?';
        params.push(batchId);
    }
    
    // Get regular stock on hand from inventory_stock_batches
    const [stockRows] = await conn.query(`
        SELECT COALESCE(SUM(qty_on_hand), 0) as regular_stock
        FROM inventory_stock_batches
        WHERE ${whereClause}
    `, params);
    
    const regularStock = parseFloat(stockRows[0]?.regular_stock || 0);
    
    // Get transit stock (IN_TRANSIT - TRANSIT_OUT)
    const [transitRows] = await conn.query(`
        SELECT 
            COALESCE(SUM(CASE WHEN movement_type_id = 3 THEN qty ELSE 0 END), 0) as transit_in,
            COALESCE(SUM(CASE WHEN movement_type_id = 4 THEN qty ELSE 0 END), 0) as transit_out
        FROM inventory_transactions
        WHERE ${whereClause}
          AND (is_deleted = 0 OR is_deleted IS NULL)
          AND movement_type_id IN (3, 4)
    `, params);
    
    const transitIn = parseFloat(transitRows[0]?.transit_in || 0);
    const transitOut = parseFloat(transitRows[0]?.transit_out || 0);
    const netTransit = transitIn - transitOut;
    
    // Stock on Hand = Regular Stock + Net Transit Stock
    const stockOnHand = regularStock + netTransit;
    
    return {
        regular_stock: regularStock,
        transit_in: transitIn,
        transit_out: transitOut,
        net_transit: netTransit,
        stock_on_hand: stockOnHand
    };
}

module.exports = {
    getMovementTypeByCode,
    getMovementTypeById,
    getAllMovementTypes,
    calculateStockOnHand
};

