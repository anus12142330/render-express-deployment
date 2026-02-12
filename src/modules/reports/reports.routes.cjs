const express = require('express');
const router = express.Router();
const reportsController = require('./reports.controller.cjs');

// Get reports for current user (with role filtering)
router.get('/', reportsController.getReports);

// Get all reports (admin/master page)
router.get('/all', reportsController.getAllReports);

// Create report
router.post('/', reportsController.createReport);

// Update report
router.put('/:id', reportsController.updateReport);

// Delete report
router.delete('/:id', reportsController.deleteReport);

// Toggle favorite
router.post('/favorite', reportsController.toggleFavorite);

module.exports = router;

