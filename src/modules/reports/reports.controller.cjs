const reportsService = require('./reports.service.cjs');
const { pool } = require('../../db/tx.cjs');

/**
 * Get reports for current user (with filtering based on role visibility)
 */
async function getReports(req, res, next) {
    try {
        const userId = req.session?.user?.id || req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Get user's role IDs
        const [userRoles] = await pool.query(`
            SELECT role_id FROM user_role WHERE user_id = ?
        `, [userId]);
        const userRoleIds = userRoles.map(ur => ur.role_id);

        const reports = await reportsService.getReports(userId, userRoleIds);
        res.json({ data: reports });
    } catch (error) {
        next(error);
    }
}

/**
 * Get all reports (admin/master page - no filtering)
 */
async function getAllReports(req, res, next) {
    try {
        const reports = await reportsService.getAllReports();
        res.json({ data: reports });
    } catch (error) {
        next(error);
    }
}

/**
 * Create a new report
 */
async function createReport(req, res, next) {
    try {
        const { title, url, section_title, column_position, sort_order, role_ids } = req.body;
        
        if (!title || !url) {
            return res.status(400).json({ error: 'Title and URL are required' });
        }

        const report = await reportsService.createReport({
            title,
            url,
            section_title,
            column_position,
            sort_order,
            role_ids
        });
        
        res.status(201).json({ data: report });
    } catch (error) {
        next(error);
    }
}

/**
 * Update a report
 */
async function updateReport(req, res, next) {
    try {
        const { id } = req.params;
        const { title, url, section_title, column_position, sort_order, role_ids } = req.body;
        
        if (!title || !url) {
            return res.status(400).json({ error: 'Title and URL are required' });
        }

        const report = await reportsService.updateReport(id, {
            title,
            url,
            section_title,
            column_position,
            sort_order,
            role_ids
        });
        
        res.json({ data: report });
    } catch (error) {
        next(error);
    }
}

/**
 * Delete a report
 */
async function deleteReport(req, res, next) {
    try {
        const { id } = req.params;
        await reportsService.deleteReport(id);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
}

/**
 * Toggle favorite for current user
 */
async function toggleFavorite(req, res, next) {
    try {
        const userId = req.session?.user?.id || req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { report_id } = req.body;
        if (!report_id) {
            return res.status(400).json({ error: 'report_id is required' });
        }

        const result = await reportsService.toggleFavorite(userId, report_id);
        res.json(result);
    } catch (error) {
        next(error);
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

