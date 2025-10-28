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
                rp.delivery_number,
                rp.delivery_date,
                rp.start_time,
                rp.start_location_address,
                rp.status,
                rp.created_at, rp.status,
                (SELECT COUNT(*) FROM route_planner_orders rpo WHERE rpo.route_id = rp.id) as orders_count
            FROM 
                route_planner rp
        `;

        const whereClauses = [];
        const params = [];

        if (search) {
            whereClauses.push(`(rp.delivery_number LIKE ? OR rp.start_location_address LIKE ?)`);
            // Add the search parameter for each '?' in the WHERE clause
            params.push(`%${search}%`, `%${search}%`);
        }

        if (whereClauses.length > 0) {
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        const countParams = [...params]; // Create a copy for the count query
        const countQuery = `SELECT COUNT(*) as total FROM route_planner rp ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}`;
        const totalRows = await q(countQuery, countParams);
        const total = totalRows[0]?.total || 0;

        query += ` ORDER BY rp.delivery_date DESC, rp.start_time DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));

        const data = await q(query, params);

        res.json({
            success: true,
            data,
            total
        });
    } catch (error) {
        console.error('Error fetching routes: ', error);
        next(error);
    }
});

/**
 * @description   Get a single route plan by its ID, including orders and helpers
 * @route         GET /api/route-planner/:id
 * @access        Private
 */
router.get('/:uniqid', async (req, res, next) => {
    try {
        const { uniqid: identifier } = req.params;

        // Determine if the identifier is a numeric ID or a string uniq_id
        const isNumericId = /^\d+$/.test(identifier);
        // The new uniq_id is a UUID, so we can reliably check if it's not numeric.
        const column = isNumericId ? 'id' : 'uniq_id';
        const sql = `SELECT * FROM route_planner WHERE ${column} = ?`;

        const routeDetails = await q(sql, [identifier]);

        if (!routeDetails.length) {
            return res.status(404).json({ message: 'Route not found.' });
        }

        const route = routeDetails[0];

        const orders = await q(`
            SELECT 
                so.id, 
                so.order_number as so_number, 
                c.display_name as customer_name, 
                csa.formatted_address, 
                csa.latitude,
                csa.longitude,
                csa.delivery_window
            FROM route_planner_orders rpo
            JOIN delivery_orders so ON rpo.order_id = so.id
            JOIN vendor c ON so.customer_id = c.id
            JOIN vendor_shipping_addresses csa ON c.id = csa.vendor_id AND csa.is_primary = 1
            WHERE rpo.route_id = ? 
            ORDER BY rpo.sequence ASC
        `, [route.id]);

        let helpers = [];
        if (route.helper_ids) {
            const helperIds = route.helper_ids.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));
            if (helperIds.length > 0) {
                // The '?' will be replaced by a comma-separated list of placeholders
                const placeholders = helperIds.map(() => '?').join(',');
                try {
                    helpers = await q(`
                        SELECT id, name 
                        FROM drivers 
                        WHERE id IN (${placeholders})
                    `, helperIds);
                } catch (e) {
                    console.error("Error fetching helpers:", e);
                    // Continue without helpers if query fails
                    helpers = [];
                }
            }
        }

        // To properly populate the Autocomplete fields, we need full objects for fleet and driver
        const fleetRows = await q('SELECT id, vehicle_name as name FROM fleets WHERE id = ?', [route.fleet_id]);
        const driverRows = await q('SELECT id, name FROM drivers WHERE id = ?', [route.driver_id]);

        // The timeline is stored as a JSON string. Parse it into an array before sending.
        let parsedTimeline = [];
        if (route.timeline) {
            try {
                parsedTimeline = JSON.parse(route.timeline);
            } catch (e) {
                console.error(`Error parsing timeline for route ${route.id}:`, e);
            }
        }

        res.json({
            ...route,
            orders,
            helpers,
            fleet: fleetRows[0] || null,
            driver: driverRows[0] || null,
            timeline: parsedTimeline, // Send the parsed array
        });

    } catch (error) {
        console.error(`Error fetching route ${req.params.uniqid}: `, error);
        next(error);
    }
});

/**
 * @description   Update an existing route plan
 * @route         PUT /api/route-planner/:id
 * @access        Private
 */
router.put('/:id', async (req, res, next) => {
    const conn = await db.promise().getConnection();
    try {
        const { id } = req.params;
        const {
            delivery_date,
            start_time,
            end_time,
            fleet_id,
            driver_id,
            helper_ids,
            start_location,
            end_location,
            orders,
            estimated_duration,
            estimated_distance,
            timeline
        } = req.body;

        // Basic validation
        if (!delivery_date || !start_time || !fleet_id || !driver_id || !start_location || !end_location || !orders || orders.length === 0) {
            return res.status(400).json({ message: 'Missing required fields for update.' });
        }

        await conn.beginTransaction();

        const helperIdsString = (helper_ids && helper_ids.length > 0) ? helper_ids.join(',') : null;

        const updateSql = `
            UPDATE route_planner SET
                delivery_date = ?, start_time = ?, end_time = ?, fleet_id = ?, driver_id = ?, helper_ids = ?,
                start_location_address = ?, start_location_lat = ?, start_location_lng = ?,
                end_location_address = ?, end_location_lat = ?, end_location_lng = ?,
                estimated_duration = ?, estimated_distance = ?, timeline = ?, updated_at = NOW(),
                status = 'planned', route_xml = NULL, published_at = NULL
            WHERE id = ?
        `;

        await conn.query(updateSql, [
            delivery_date, start_time, end_time, fleet_id, driver_id, helperIdsString,
            start_location.address, start_location.lat, start_location.lng,
            end_location.address, end_location.lat, end_location.lng,
            estimated_duration, estimated_distance, JSON.stringify(timeline),
            id
        ]);

        // First, remove all existing orders for this route
        await conn.query('DELETE FROM route_planner_orders WHERE route_id = ?', [id]);

        // Then, insert the new set of orders with the correct sequence
        const orderPromises = orders.map((orderId, index) => {
            return conn.query('INSERT INTO route_planner_orders (route_id, order_id, sequence) VALUES (?, ?, ?)', [id, orderId, index + 1]);
        });

        await Promise.all(orderPromises);

        await conn.commit();

        res.json({ success: true, message: 'Route updated successfully' });

    } catch (error) {
        await conn.rollback();
        console.error(`Error updating route ${req.params.id}: `, error);
        next(error);
    } finally {
        conn.release();
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
            end_time,
            fleet_id,
            driver_id,
            helper_ids, // Changed from helper_id to helper_ids
            start_location, // { address, lat, lng }
            end_location, // { address, lat, lng }
            orders, // array of order IDs
            estimated_duration,
            estimated_distance,
            timeline
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
             FROM delivery_orders so 
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

        const [[lastRoute]] = await conn.query(`SELECT delivery_number FROM route_planner WHERE delivery_number LIKE ? ORDER BY delivery_number DESC LIMIT 1`, [`${searchPrefix}%`]);
        const lastNum = lastRoute ? parseInt(lastRoute.delivery_number.slice(-3), 10) : 0;
        const nextNum = (lastNum + 1).toString().padStart(3, '0');

        const delivery_number = `${searchPrefix}${nextNum}`;
        // --- End of New Logic ---

        const uniq_id = crypto.randomUUID();
        // Convert array of helper IDs to a comma-separated string
        const helperIdsString = (helper_ids && helper_ids.length > 0) ? helper_ids.join(',') : null;

        const routeSql = `
            INSERT INTO route_planner (uniq_id, delivery_number, delivery_date, start_time, end_time, fleet_id, driver_id, helper_ids, start_location_address, start_location_lat, start_location_lng, end_location_address, end_location_lat, end_location_lng, estimated_duration, estimated_distance, timeline, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
        `;
        const [routeResult] = await conn.query(routeSql, [
            uniq_id, delivery_number, delivery_date, start_time, end_time, fleet_id, driver_id, helperIdsString, start_location.address, start_location.lat, start_location.lng, end_location.address, end_location.lat, end_location.lng, estimated_duration, estimated_distance, JSON.stringify(timeline), req.session?.user?.id
        ]);

        const routeId = routeResult.insertId;

        const orderPromises = orders.map((orderId, index) => {
            return conn.query('INSERT INTO route_planner_orders (route_id, order_id, sequence) VALUES (?, ?, ?)', [routeId, orderId, index + 1]);
        });

        // Wait for all inserts to complete
        await Promise.all(orderPromises);

        await conn.commit();

        res.status(201).json({ success: true, message: 'Route created successfully', data: { id: routeId, uniq_id } });

    } catch (error) {
        await conn.rollback();
        console.error('Error creating route: ', error);
        next(error);
    } finally {
        conn.release();
    }
});

/**
 * @description   Publish a route, setting its status and saving the XML
 * @route         POST /api/route-planner/:id/publish
 * @access        Private
 */
router.post('/:id/publish', async (req, res, next) => {
    const conn = await db.promise().getConnection();
    await conn.beginTransaction(); // Start a transaction

    try {
        const { id } = req.params;
        const { routeXml } = req.body;

        if (!routeXml) {
            return res.status(400).json({ message: 'Route XML data is required to publish.' });
        }

        // Ensure the route exists before trying to update it.
        const [[routeExists]] = await conn.query('SELECT id FROM route_planner WHERE id = ?', [id]);
        if (!routeExists) {
            return res.status(404).json({ message: 'Route not found.' });
        }

        const updateSql = `UPDATE route_planner SET status = 'published', route_xml = ?, published_at = NOW() WHERE id = ?`;
        await conn.query(updateSql, [routeXml, id]);

        await conn.commit(); // Commit the transaction to save changes

        res.json({ success: true, message: 'Route published successfully.' });
    } catch (error) {
        console.error(`Error publishing route ${req.params.id}: `, error);
        await conn.rollback(); // Rollback on error
        next(error);
    } finally {
        conn.release();
    }
});

export default router;
