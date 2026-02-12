// server/src/modules/inventory/inventory.routes.js
const express = require('express');
const router = express.Router();
const inventoryService = require('./inventory.service.cjs');

router.get('/batches', async (req, res, next) => {
    try {
        const productId = req.query.product_id;
        const warehouseId = req.query.warehouse_id;
        if (!productId || !warehouseId) {
            return res.status(400).json({ error: 'product_id and warehouse_id are required' });
        }
        const batches = await inventoryService.getAvailableBatches(parseInt(productId, 10), parseInt(warehouseId, 10));
        res.json(batches);
    } catch (error) {
        next(error);
    }
});

router.get('/stock-batches', async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const search = (req.query.search || '').trim();
        const offset = (page - 1) * perPage;

        const filters = {
            product_id: req.query.product_id ? parseInt(req.query.product_id, 10) : null,
            warehouse_id: req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null,
            batch_id: req.query.batch_id ? parseInt(req.query.batch_id, 10) : null,
            search: search
        };

        const result = await inventoryService.getBatchStock(filters, offset, perPage);
        res.json({
            data: result.rows || [],
            totalRows: result.total || 0
        });
    } catch (error) {
        next(error);
    }
});

router.get('/transactions', async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const search = (req.query.search || '').trim();
        const offset = (page - 1) * perPage;

        const filters = {
            source_type: req.query.source_type || null,
            source_id: req.query.source_id ? parseInt(req.query.source_id, 10) : null,
            product_id: req.query.product_id ? parseInt(req.query.product_id, 10) : null,
            warehouse_id: req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null,
            batch_id: req.query.batch_id ? parseInt(req.query.batch_id, 10) : null,
            qc_posting_type: req.query.qc_posting_type || null,
            from: req.query.from || null,
            to: req.query.to || null,
            search: search
        };
        const result = await inventoryService.getInventoryTransactions(filters, offset, perPage);
        res.json({
            data: result.rows || [],
            totalRows: result.total || 0
        });
    } catch (error) {
        next(error);
    }
});

router.get('/near-expiry', async (req, res, next) => {
    try {
        const days = parseInt(req.query.days || '30', 10);
        const warehouseId = req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null;
        const batches = await inventoryService.getNearExpiryBatches(days, warehouseId);
        res.json(batches);
    } catch (error) {
        next(error);
    }
});

router.get('/batches-list', async (req, res, next) => {
    try {
        const batches = await inventoryService.getAllBatches();
        res.json(batches);
    } catch (error) {
        next(error);
    }
});

module.exports = router;

