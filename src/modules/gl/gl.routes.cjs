const express = require('express');
const router = express.Router();
const glController = require('./gl.controller.cjs');

// Trial Balance endpoint
router.get('/trial-balance', glController.getTrialBalance);

// Account Journal Entries endpoint
router.get('/account-journal-entries', glController.getAccountJournalEntries);

// Account Info endpoint
router.get('/account-info', glController.getAccountInfo);

// Chart of Accounts with Balances endpoint
router.get('/chart-of-accounts', glController.getChartOfAccounts);

// Profit and Loss Statement endpoint
router.get('/profit-and-loss', glController.getProfitAndLoss);

// Detailed Profit and Loss Statement endpoint
router.get('/profit-and-loss-detailed', glController.getProfitAndLossDetailed);

// Entity Ledger Balance endpoint
router.get('/entities/:type/:id/balance', glController.getEntityBalanceEndpoint);

// Rebuild Entity Balances endpoint (admin)
router.post('/admin/rebuild-entity-balances', glController.rebuildEntityBalancesEndpoint);

module.exports = router;

