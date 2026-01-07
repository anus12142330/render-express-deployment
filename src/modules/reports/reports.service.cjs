const { pool } = require('../../db/tx.cjs');

/**
 * Get all reports with user favorites and role visibility
 */
async function getReports(userId, userRoleIds = []) {
    const [reports] = await pool.query(`
        SELECT 
            r.*,
            CASE WHEN rf.id IS NOT NULL THEN 1 ELSE 0 END as is_favorite
        FROM reports r
        LEFT JOIN report_favorites rf ON rf.report_id = r.id AND rf.user_id = ?
        WHERE r.is_active = 1
        ORDER BY r.section_title, r.sort_order, r.id
    `, [userId]);

    // Filter reports based on role visibility
    // If a report has role restrictions, only show it if user has one of those roles
    // If a report has no role restrictions, show it to everyone
    const filteredReports = [];
    
    for (const report of reports) {
        const [roleVisibility] = await pool.query(`
            SELECT role_id FROM report_role_visibility WHERE report_id = ?
        `, [report.id]);
        
        // If no role restrictions, show to everyone
        if (roleVisibility.length === 0) {
            filteredReports.push(report);
        } else {
            // Check if user has one of the required roles
            const visibleRoleIds = roleVisibility.map(rv => rv.role_id);
            const hasAccess = userRoleIds.some(roleId => visibleRoleIds.includes(roleId));
            if (hasAccess) {
                filteredReports.push(report);
            }
        }
    }

    return filteredReports;
}

/**
 * Get all reports (admin/master page - no filtering)
 */
async function getAllReports() {
    const [reports] = await pool.query(`
        SELECT 
            r.*,
            GROUP_CONCAT(DISTINCT rrv.role_id) as visible_role_ids,
            GROUP_CONCAT(DISTINCT rol.name SEPARATOR ', ') as visible_role_names
        FROM reports r
        LEFT JOIN report_role_visibility rrv ON rrv.report_id = r.id
        LEFT JOIN role rol ON rol.id = rrv.role_id
        WHERE r.is_active = 1
        GROUP BY r.id
        ORDER BY r.section_title, r.sort_order, r.id
    `);

    return reports.map(r => ({
        ...r,
        visible_role_ids: r.visible_role_ids ? r.visible_role_ids.split(',').map(Number) : [],
        visible_role_names: r.visible_role_names || ''
    }));
}

/**
 * Create a new report
 */
async function createReport(reportData) {
    const { title, url, section_title, column_position, sort_order, role_ids } = reportData;
    
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    
    try {
        const [result] = await conn.query(`
            INSERT INTO reports (title, url, section_title, column_position, sort_order)
            VALUES (?, ?, ?, ?, ?)
        `, [title, url, section_title || 'General', column_position || 'left', sort_order || 0]);
        
        const reportId = result.insertId;
        
        // Add role visibility
        if (role_ids && Array.isArray(role_ids) && role_ids.length > 0) {
            const values = role_ids.map(roleId => [reportId, roleId]);
            await conn.query(`
                INSERT INTO report_role_visibility (report_id, role_id)
                VALUES ?
            `, [values]);
        }
        
        await conn.commit();
        return { id: reportId, ...reportData };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

/**
 * Update a report
 */
async function updateReport(reportId, reportData) {
    const { title, url, section_title, column_position, sort_order, role_ids } = reportData;
    
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    
    try {
        await conn.query(`
            UPDATE reports
            SET title = ?, url = ?, section_title = ?, column_position = ?, sort_order = ?
            WHERE id = ?
        `, [title, url, section_title || 'General', column_position || 'left', sort_order || 0, reportId]);
        
        // Update role visibility
        await conn.query(`DELETE FROM report_role_visibility WHERE report_id = ?`, [reportId]);
        
        if (role_ids && Array.isArray(role_ids) && role_ids.length > 0) {
            const values = role_ids.map(roleId => [reportId, roleId]);
            await conn.query(`
                INSERT INTO report_role_visibility (report_id, role_id)
                VALUES ?
            `, [values]);
        }
        
        await conn.commit();
        return { id: reportId, ...reportData };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

/**
 * Delete a report (soft delete)
 */
async function deleteReport(reportId) {
    await pool.query(`UPDATE reports SET is_active = 0 WHERE id = ?`, [reportId]);
    return { success: true };
}

/**
 * Toggle favorite for a user
 */
async function toggleFavorite(userId, reportId) {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    
    try {
        // Check if favorite exists
        const [existing] = await conn.query(`
            SELECT id FROM report_favorites WHERE user_id = ? AND report_id = ?
        `, [userId, reportId]);
        
        if (existing.length > 0) {
            // Remove favorite
            await conn.query(`
                DELETE FROM report_favorites WHERE user_id = ? AND report_id = ?
            `, [userId, reportId]);
            await conn.commit();
            return { is_favorite: false };
        } else {
            // Add favorite
            await conn.query(`
                INSERT INTO report_favorites (user_id, report_id)
                VALUES (?, ?)
            `, [userId, reportId]);
            await conn.commit();
            return { is_favorite: true };
        }
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

module.exports = {
    getReports,
    getAllReports,
    createReport,
    updateReport,
    deleteReport,
    toggleFavorite
};

