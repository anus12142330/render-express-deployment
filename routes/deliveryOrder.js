import { Router } from 'express';
import db from '../db.js';

const router = Router();
const q = async (sql, params = []) => (await db.promise().query(sql, params))[0];

/**
 * @description   Get orders that are confirmed and not yet delivered/closed for planning
 * @route         GET /api/sales-orders/plannable
 * @access        Private
 */
router.get('/plannable', async (req, res, next) => {
    try {
        // This query joins sales orders with their primary shipping address.
        // It filters for orders that are 'confirmed' and have not yet been assigned to a route.
        // It also ensures that the delivery address has valid coordinates.
        const orders = await q(`
            SELECT 
                so.id,
                so.order_number as so_number,
                c.id as customer_id,
                c.display_name as customer_name,
                csa.id as address_id,
                csa.ship_attention as address_label,
                csa.latitude,
                csa.longitude,
                csa.formatted_address,
                csa.delivery_window
            FROM delivery_orders so
            JOIN vendor c ON so.customer_id = c.id
            JOIN vendor_shipping_addresses csa ON c.id = csa.vendor_id AND csa.is_primary = 1
            LEFT JOIN route_planner_orders rpo ON so.id = rpo.order_id
            WHERE 
                so.status_id = 7 -- '7' is the ID for 'Confirmed' status
                AND csa.latitude IS NOT NULL 
                AND csa.longitude IS NOT NULL
                AND rpo.order_id IS NULL
        `);

        res.json(orders);
    } catch (error) {
        console.error('Error fetching plannable orders:', error);
        next(error);
    }
});

export default router;
