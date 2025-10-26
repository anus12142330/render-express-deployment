import { Router } from 'express';
import db from '../db.js';
import crypto from 'crypto';

const router = Router();

const q = async (sql, params = []) => (await db.promise().query(sql, params))[0];

/**
 * @description   Get all planned routes with filtering and pagination
 * @route         GET /api/route-planner
 * @access        Private
 */
router.get('/', async (req, res, next) => {
    try {
        const { limit = 25, offset = 0, search } = req.query;

        let query = `
            SELECT 
                rp.id,
                rp.uniq_id,
                rp.delivery_date,
                rp.start_time,
                rp.start_location_address,
                rp.status,
                rp.created_at,
                (SELECT COUNT(*) FROM route_planner_orders rpo WHERE rpo.route_id = rp.id) as orders_count
            FROM 
                route_planner rp
        `;

        const whereClauses = [];
        const params = [];

        if (search) {
            whereClauses.push(`(rp.uniq_id LIKE ? OR rp.start_location_address LIKE ?)`);
            params.push(`%${search}%`, `%${search}%`);
        }

        if (whereClauses.length > 0) {
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        const countQuery = `SELECT COUNT(*) as total FROM route_planner rp ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}`;
        const [totalRows] = await q(countQuery, params);
        const total = totalRows[0].total;

        query += ` ORDER BY rp.delivery_date DESC, rp.start_time DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));

        const data = await q(query, params);

        res.json({
            success: true,
            data,
            total
        });
    } catch (error) {
        console.error('Error fetching routes:', error);
        next(error);
    }
});

/**
 * @description   Get a single route plan by its ID, including orders and helpers
 * @route         GET /api/route-planner/:id
 * @access        Private
 */
router.get('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;

        const [routeDetails] = await q('SELECT * FROM route_planner WHERE id = ?', [id]);

        if (!routeDetails.length) {
            return res.status(404).json({ message: 'Route not found.' });
        }

        const route = routeDetails[0];

        const orders = await q(`
            SELECT so.id, so.so_number, c.display_name as customer_name, csa.formatted_address, csa.latitude, csa.longitude
            FROM route_planner_orders rpo
            JOIN sales_orders so ON rpo.order_id = so.id
            JOIN customers c ON so.customer_id = c.id
            JOIN customer_shipping_addresses csa ON c.id = csa.customer_id AND csa.is_primary = 1
            WHERE rpo.route_id = ?
        `, [id]);

        const helpers = await q(`
            SELECT d.id, d.name
            FROM route_planner_helpers rph
            JOIN driver d ON rph.helper_id = d.id
            WHERE rph.route_id = ?
        `, [id]);

        // To properly populate the Autocomplete fields, we need full objects for fleet and driver
        const [fleet] = await q('SELECT id, vehicle_name as name FROM fleets WHERE id = ?', [route.fleet_id]);
        const [driver] = await q('SELECT id, name FROM drivers WHERE id = ?', [route.driver_id]);

        res.json({
            ...route,
            orders,
            helpers,
            fleet: fleet[0] || null,
            driver: driver[0] || null,
        });

    } catch (error) {
        console.error(`Error fetching route ${req.params.id}:`, error);
        next(error);
    }
});
/**
 * @description   Create a new route plan
 * @route         POST /api/route-planner
 * @access        Private
 */
router.post('/', async (req, res, next) => {
    const conn = await db.promise().getConnection();
    try {
        const {
            delivery_date,
            start_time,
            fleet_id,
            driver_id,
            helper_ids, // Changed from helper_id to helper_ids
            start_location, // { address, lat, lng }
            end_location, // { address, lat, lng }
            orders, // array of order IDs
            estimated_duration,
            estimated_distance
        } = req.body;

        // Basic validation
        if (!delivery_date || !start_time || !fleet_id || !driver_id || !start_location || !end_location || !orders || orders.length === 0) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        await conn.beginTransaction();

        // --- New Delivery Number Generation Logic ---
        const firstOrderId = orders[0];
        const [[customerRow]] = await conn.query(
            `SELECT v.customer_of 
             FROM sales_orders so 
             JOIN vendor v ON so.customer_id = v.id 
             WHERE so.id = ?`, 
            [firstOrderId]
        );

        let companyId = null;
        if (customerRow?.customer_of) {
            // Assuming customer_of is a comma-separated string of IDs, take the first one.
            companyId = customerRow.customer_of.split(',')[0];
        }

        // Fallback to the first company if the customer isn't linked
        if (!companyId) {
            const [[firstCompany]] = await conn.query('SELECT id FROM company_settings ORDER BY id ASC LIMIT 1');
            companyId = firstCompany?.id;
        }

        const [[companyRow]] = await conn.query('SELECT company_prefix FROM company_settings WHERE id = ?', [companyId]);
        const prefix = companyRow?.company_prefix || 'AA'; // Default prefix

        const date = new Date(delivery_date);
        const year = date.getFullYear().toString().slice(-2);
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const searchPrefix = `${prefix}DO-${year}-${month}`;

        const [[lastRoute]] = await conn.query(`SELECT uniq_id FROM route_planner WHERE uniq_id LIKE ? ORDER BY uniq_id DESC LIMIT 1`, [`${searchPrefix}%`]);
        const lastNum = lastRoute ? parseInt(lastRoute.uniq_id.slice(-3), 10) : 0;
        const nextNum = (lastNum + 1).toString().padStart(3, '0');

        const uniq_id = `${searchPrefix}${nextNum}`;
        // --- End of New Logic ---

        const routeSql = `
            INSERT INTO route_planner (uniq_id, delivery_date, start_time, fleet_id, driver_id, start_location_address, start_location_lat, start_location_lng, end_location_address, end_location_lat, end_location_lng, estimated_duration, estimated_distance, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
        `;
        const [routeResult] = await conn.query(routeSql, [
            uniq_id, delivery_date, start_time, fleet_id, driver_id, start_location.address, start_location.lat, start_location.lng, end_location.address, end_location.lat, end_location.lng, estimated_duration, estimated_distance, req.session?.user?.id
        ]);

        const routeId = routeResult.insertId;

        const orderPromises = orders.map(orderId => {
            return conn.query('INSERT INTO route_planner_orders (route_id, order_id) VALUES (?, ?)', [routeId, orderId]);
        });

        // Insert multiple helpers if they exist
        const helperPromises = (helper_ids || []).map(helperId => {
            return conn.query('INSERT INTO route_planner_helpers (route_id, helper_id) VALUES (?, ?)', [routeId, helperId]);
        });

        // Wait for all inserts to complete
        await Promise.all([...orderPromises, ...helperPromises]);

        await conn.commit();

        res.status(201).json({ success: true, message: 'Route created successfully', data: { id: routeId, uniq_id } });

    } catch (error) {
        await conn.rollback();
        console.error('Error creating route:', error);
        next(error);
    } finally {
        conn.release();
    }
});

export default router;
