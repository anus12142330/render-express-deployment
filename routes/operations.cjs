const express = require('express');
const router = express.Router();
const { tx, pool } = require('../src/db/tx.cjs');

const isYesNo = (value) => value === 'YES' || value === 'NO';

const normalizeString = (value) => String(value ?? '').trim();

const validatePayload = (payload) => {
  const errors = [];
  const fromStage = normalizeString(payload.from_stage);
  const toStage = normalizeString(payload.to_stage);
  const supplierLoggerInstalled = normalizeString(payload.supplier_logger_installed);
  const loggerCount = Number(payload.logger_count || 0);
  const loggers = Array.isArray(payload.loggers) ? payload.loggers : [];

  if (fromStage !== 'UNDERLOADING') errors.push('from_stage must be UNDERLOADING');
  if (toStage !== 'SAILED') errors.push('to_stage must be SAILED');
  if (!isYesNo(supplierLoggerInstalled)) errors.push('supplier_logger_installed must be YES or NO');

  if (supplierLoggerInstalled === 'YES') {
    if (!Number.isFinite(loggerCount) || loggerCount < 1) {
      errors.push('logger_count must be greater than 0');
    }
    if (loggerCount > 20) errors.push('logger_count exceeds limit');
    if (loggers.length !== loggerCount) {
      errors.push('loggers length must match logger_count');
    }
    loggers.forEach((row, idx) => {
      if (!normalizeString(row.serial_no)) errors.push(`serial_no required at row ${idx + 1}`);
      if (!normalizeString(row.installation_place)) errors.push(`installation_place required at row ${idx + 1}`);
    });
  } else if (supplierLoggerInstalled === 'NO') {
    if (loggerCount !== 0) errors.push('logger_count must be 0 when supplier_logger_installed is NO');
    if (loggers.length > 0) errors.push('loggers must be empty when supplier_logger_installed is NO');
  }

  return {
    errors,
    data: {
      fromStage,
      toStage,
      supplierLoggerInstalled,
      loggerCount: supplierLoggerInstalled === 'YES' ? loggerCount : 0,
      loggers: supplierLoggerInstalled === 'YES' ? loggers : [],
    },
  };
};

router.post('/operations/:operationdetails_id/sailed-transition', async (req, res) => {
  const operationId = Number(req.params.operationdetails_id || 0);
  if (!Number.isFinite(operationId) || operationId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid operationdetails_id' });
  }

  const { errors, data } = validatePayload(req.body || {});
  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  try {
    const transitionId = await tx(async (conn) => {
      const [operationRows] = await conn.query(
        'SELECT id FROM operation_details WHERE id = ? LIMIT 1',
        [operationId]
      );
      if (!operationRows.length) {
        const err = new Error('Operation details not found');
        err.status = 404;
        throw err;
      }

      const createdBy = req.session?.user?.id || req.user?.id || null;
      const [result] = await conn.query(
        `INSERT INTO operation_stage_transitions
          (operationdetails_id, from_stage, to_stage, supplier_logger_installed, logger_count, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          operationId,
          data.fromStage,
          data.toStage,
          data.supplierLoggerInstalled,
          data.loggerCount,
          createdBy
        ]
      );

      const insertId = result.insertId;
      if (data.supplierLoggerInstalled === 'YES' && data.loggers.length > 0) {
        const values = data.loggers.map((row) => [
          insertId,
          normalizeString(row.serial_no),
          normalizeString(row.installation_place),
        ]);
        await conn.query(
          'INSERT INTO operation_temperature_loggers (transition_id, serial_no, installation_place) VALUES ?',
          [values]
        );
      }

      try {
        await conn.query(
          'UPDATE operation_details SET stage = ?, sailed_date = NOW() WHERE id = ?',
          ['SAILED', operationId]
        );
      } catch (err) {
        if (err?.code === 'ER_BAD_FIELD_ERROR') {
          await conn.query('UPDATE operation_details SET stage = ? WHERE id = ?', ['SAILED', operationId]);
        } else {
          throw err;
        }
      }

      return insertId;
    });

    res.json({ success: true, transition_id: transitionId });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message || 'Failed to save transition' });
  }
});

router.get('/operations/:operationdetails_id/sailed-transition', async (req, res) => {
  const operationId = Number(req.params.operationdetails_id || 0);
  if (!Number.isFinite(operationId) || operationId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid operationdetails_id' });
  }

  try {
    const [transitions] = await pool.query(
      `SELECT *
       FROM operation_stage_transitions
       WHERE operationdetails_id = ? AND to_stage = 'SAILED'
       ORDER BY id DESC
       LIMIT 1`,
      [operationId]
    );

    if (!transitions.length) {
      return res.json({ success: true, transition: null, loggers: [] });
    }

    const transition = transitions[0];
    const [loggers] = await pool.query(
      'SELECT serial_no, installation_place FROM operation_temperature_loggers WHERE transition_id = ? ORDER BY id ASC',
      [transition.id]
    );

    res.json({ success: true, transition, loggers: loggers || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load transition' });
  }
});

module.exports = router;
