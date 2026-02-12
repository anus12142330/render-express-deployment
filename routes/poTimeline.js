// server/routes/poTimeline.js
// API endpoint for PO "In Hand" timeline view
import express from "express";
import db from "../db.js";
import dayjs from "dayjs";

const router = express.Router();
const errPayload = (message, type = "APP_ERROR", hint) => ({ error: { message, type, hint } });

/**
 * Service function to build PO timeline ranges
 * Implements Case 1 (Dubai Trade) and Case 2 (Stage dates fallback) logic
 */
const buildPoTimeline = (poRows, dubaiRows, eventsRows, returnRows) => {
  const timeline = [];
  
  // Create maps for quick lookup
  const dubaiByPo = new Map();
  (dubaiRows || []).forEach(row => {
    const key = row.po_id || row.po_no;
    if (!dubaiByPo.has(key)) dubaiByPo.set(key, []);
    dubaiByPo.get(key).push(row);
  });
  
  const eventsByPo = new Map();
  (eventsRows || []).forEach(row => {
    const key = row.po_id || row.po_no;
    if (!eventsByPo.has(key)) eventsByPo.set(key, []);
    eventsByPo.get(key).push(row);
  });
  
  const returnsByPo = new Map();
  (returnRows || []).forEach(row => {
    const key = row.po_id || row.po_no || row.container_no;
    if (!returnsByPo.has(key)) returnsByPo.set(key, []);
    returnsByPo.get(key).push(row);
  });
  
  // Group PO rows by PO ID (one PO can have multiple shipments/containers)
  const poGroups = new Map();
  (poRows || []).forEach(po => {
    const poId = po.id;
    if (!poGroups.has(poId)) {
      poGroups.set(poId, {
        id: poId,
        po_number: po.po_number,
        po_uniqid: po.po_uniqid,
        shipments: []
      });
    }
    poGroups.get(poId).shipments.push(po);
  });
  
  // Process each PO group
  poGroups.forEach((poGroup, poId) => {
    const poNo = poGroup.po_number;
    const shipments = poGroup.shipments;
    
    // Get Dubai Trade data for this PO (by shipment_id)
    const shipmentIds = shipments.map(s => s.shipment_id).filter(Boolean);
    const dubaiData = dubaiRows.filter(d => shipmentIds.includes(d.shipment_id));
    const dubaiRecord = dubaiData[0] || null;
    
    // Get stage events for this PO (from shipments)
    const sailedShipment = shipments.find(s => s.shipment_stage_id === 4);
    const clearedShipment = shipments.find(s => s.shipment_stage_id === 5);
    
    // Get return data for containers in this PO
    const containerIds = shipments.map(s => s.container_id).filter(Boolean);
    const returnData = returnRows.filter(r => containerIds.includes(r.container_id));
    const returnRecord = returnData[0] || null;
    
    // Get container numbers
    const containerNos = shipments.map(s => s.container_no).filter(Boolean);
    const containerNo = containerNos[0] || null;
    
    const ranges = [];
    
    // Case 1: Dubai Trade has all dates
    if (dubaiRecord?.discharge_date && dubaiRecord?.to_town_date && dubaiRecord?.from_date) {
      // Range 1: Discharge → To Town
      const dischargeDate = dayjs(dubaiRecord.discharge_date).format('YYYY-MM-DD');
      const toTownDate = dayjs(dubaiRecord.to_town_date).format('YYYY-MM-DD');
      
      if (dischargeDate && toTownDate) {
        ranges.push({
          id: `${poNo}-A`,
          type: 'DISCHARGE_TO_TOTOWN',
          label: 'Discharge → To Town',
          start: dischargeDate,
          end: toTownDate,
          source: 'dubai_trade'
        });
      }
      
      // Range 2: To Town → From Town
      const fromDate = dayjs(dubaiRecord.from_date).format('YYYY-MM-DD');
      if (toTownDate && fromDate) {
        ranges.push({
          id: `${poNo}-B`,
          type: 'TOTOWN_TO_FROMTOWN',
          label: 'To Town → From Town',
          start: toTownDate,
          end: fromDate,
          source: 'dubai_trade'
        });
      }
    } else {
      // Case 2: Fallback to stage dates
      // Discharge date: sailing_date from Sailed stage (stage 4) OR Dubai Trade discharge
      let dischargeDateOrEta = null;
      if (sailedShipment?.sailing_date) {
        dischargeDateOrEta = dayjs(sailedShipment.sailing_date).format('YYYY-MM-DD');
      } else if (sailedShipment?.eta_date) {
        dischargeDateOrEta = dayjs(sailedShipment.eta_date).format('YYYY-MM-DD');
      } else if (dubaiRecord?.discharge_date) {
        // Use Dubai Trade discharge if available (partial Dubai Trade data)
        dischargeDateOrEta = dayjs(dubaiRecord.discharge_date).format('YYYY-MM-DD');
      }
      
      // To Town: cleared date from Cleared stage (stage 5)
      let toTownClearedDate = null;
      if (clearedShipment?.cleared_date) {
        toTownClearedDate = dayjs(clearedShipment.cleared_date).format('YYYY-MM-DD');
      } else if (dubaiRecord?.to_town_date) {
        // Use Dubai Trade to_town if available
        toTownClearedDate = dayjs(dubaiRecord.to_town_date).format('YYYY-MM-DD');
      }
      
      // From Town: return date from container_return (return_date is the from_town_date)
      let fromTownReturnDate = null;
      if (returnRecord?.return_date) {
        fromTownReturnDate = dayjs(returnRecord.return_date).format('YYYY-MM-DD');
      } else if (dubaiRecord?.from_date) {
        // Use Dubai Trade from_date if available
        fromTownReturnDate = dayjs(dubaiRecord.from_date).format('YYYY-MM-DD');
      }
      
      // Build Range 1: Discharge → To Town
      if (dischargeDateOrEta && toTownClearedDate) {
        ranges.push({
          id: `${poNo}-A`,
          type: 'DISCHARGE_TO_TOTOWN',
          label: 'Discharge → To Town',
          start: dischargeDateOrEta,
          end: toTownClearedDate,
          source: 'stage_dates'
        });
      }
      
      // Build Range 2: To Town → From Town
      if (toTownClearedDate && fromTownReturnDate) {
        ranges.push({
          id: `${poNo}-B`,
          type: 'TOTOWN_TO_FROMTOWN',
          label: 'To Town → From Town',
          start: toTownClearedDate,
          end: fromTownReturnDate,
          source: 'stage_dates'
        });
      }
    }
    
    // Only add PO to timeline if it has at least one range
    if (ranges.length > 0) {
      timeline.push({
        poNo,
        containerNo: containerNo || (containerNos.length > 0 ? containerNos.join(', ') : null),
        poId,
        ranges
      });
    }
  });
  
  return timeline;
};

/**
 * GET /api/po-timeline
 * Query params:
 *   - poNo: Filter by specific PO number
 *   - fromDate: Start date for calendar month (YYYY-MM-DD)
 *   - toDate: End date for calendar month (YYYY-MM-DD)
 */
router.get("/", async (req, res) => {
  try {
    const { poNo, fromDate, toDate } = req.query;
    
    // Build WHERE clause for PO query
    let poWhere = "WHERE 1=1";
    const poParams = [];
    
    if (poNo) {
      poWhere += " AND po.po_number = ?";
      poParams.push(poNo);
    }
    
    // Query purchase orders
    // discharge_date should come from shipment table (via Dubai Trade subquery) or eta_date as fallback
    const [poRows] = await db.promise().query(
      `SELECT 
        po.id,
        po.po_number,
        po.po_uniqid,
        -- Get discharge_date from Dubai Trade (same as shipment.js board endpoint)
        (
          SELECT DATE_FORMAT(MIN(dtcs.discharge_date), '%Y-%m-%d')
          FROM dubai_trade_container_status dtcs 
          WHERE dtcs.shipment_id = s.id
        ) as discharge_date,
        DATE_FORMAT(s.eta_date, '%Y-%m-%d') as eta_date,
        DATE_FORMAT(s.sailing_date, '%Y-%m-%d') as sailing_date,
        DATE_FORMAT(s.confirm_arrival_date, '%Y-%m-%d') as confirm_arrival_date,
        sc.container_no,
        sc.id as container_id
      FROM purchase_orders po
      LEFT JOIN shipment s ON s.po_id = po.id
      LEFT JOIN shipment_container sc ON sc.shipment_id = s.id
      ${poWhere}
      GROUP BY po.id, sc.id
      ORDER BY po.po_number, sc.container_no`,
      poParams
    );
    
    if (!poRows || poRows.length === 0) {
      return res.json([]);
    }
    
    const poIds = [...new Set(poRows.map(r => r.id).filter(Boolean))];
    const shipmentIds = poRows.map(r => r.shipment_id).filter(Boolean);
    const containerIds = poRows.map(r => r.container_id).filter(Boolean);
    
    // Query Dubai Trade data
    let dubaiRows = [];
    if (shipmentIds.length > 0) {
      const [dubaiData] = await db.promise().query(
        `SELECT 
          dtcs.shipment_id,
          s.po_id,
          DATE_FORMAT(MIN(dtcs.discharge_date), '%Y-%m-%d') as discharge_date,
          DATE_FORMAT(
            MAX(CASE WHEN UPPER(m.move) LIKE '%TO TOWN%' THEN 
              COALESCE(
                STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                STR_TO_DATE(m.date, '%Y-%m-%d'),
                STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                STR_TO_DATE(m.date, '%d-%b-%Y')
              )
            END),
            '%Y-%m-%d'
          ) as to_town_date,
          DATE_FORMAT(
            MAX(CASE WHEN (UPPER(m.move) LIKE '%FROM_TOWN%' OR UPPER(m.move) LIKE '%FROM TOWN%') THEN 
              COALESCE(
                STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                STR_TO_DATE(m.date, '%Y-%m-%d'),
                STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                STR_TO_DATE(m.date, '%d-%b-%Y')
              )
            END),
            '%Y-%m-%d'
          ) as from_date
        FROM dubai_trade_container_status dtcs
        INNER JOIN shipment s ON s.id = dtcs.shipment_id
        LEFT JOIN dubai_trade_container_moves m ON m.dubai_trade_status_id = dtcs.id
        WHERE dtcs.shipment_id IN (?)
        GROUP BY dtcs.shipment_id, s.po_id`,
        [shipmentIds]
      );
      dubaiRows = dubaiData || [];
    }
    
    // Query stage events (sailed, cleared) - already have this data in poRows, but extract it
    let eventsRows = [];
    if (shipmentIds.length > 0) {
      // Extract stage data from poRows and format as events
      poRows.forEach(row => {
        if (row.shipment_id && row.shipment_stage_id >= 4) {
          eventsRows.push({
            po_id: row.id,
            shipment_id: row.shipment_id,
            stage_id: row.shipment_stage_id,
            stage: row.shipment_stage_id === 4 ? 'sailed' : (row.shipment_stage_id === 5 ? 'cleared' : null),
            sailing_date: row.sailing_date,
            eta: row.eta_date,
            cleared_date: row.cleared_date
          });
        }
      });
    }
    
    // Query container returns
    let returnRows = [];
    if (containerIds.length > 0) {
      const [returnData] = await db.promise().query(
        `SELECT 
          scr.container_id,
          sc.shipment_id,
          s.po_id,
          sc.container_no,
          DATE_FORMAT(scr.return_date, '%Y-%m-%d') as return_date,
          DATE_FORMAT(scr.to_town_date, '%Y-%m-%d') as to_town_date
        FROM shipment_container_return scr
        INNER JOIN shipment_container sc ON sc.id = scr.container_id
        INNER JOIN shipment s ON s.id = sc.shipment_id
        WHERE scr.container_id IN (?)`,
        [containerIds]
      );
      returnRows = returnData || [];
    }
    
    // Build timeline
    const timeline = buildPoTimeline(poRows, dubaiRows, eventsRows, returnRows);
    
    // Filter by date range if provided
    let filteredTimeline = timeline;
    if (fromDate || toDate) {
      filteredTimeline = timeline.filter(po => {
        return po.ranges.some(range => {
          const rangeStart = dayjs(range.start);
          const rangeEnd = dayjs(range.end);
          const from = fromDate ? dayjs(fromDate) : null;
          const to = toDate ? dayjs(toDate) : null;
          
          if (from && rangeEnd.isBefore(from, 'day')) return false;
          if (to && rangeStart.isAfter(to, 'day')) return false;
          return true;
        });
      });
    }
    
    res.json(filteredTimeline);
  } catch (err) {
    console.error("PO Timeline API Error:", err);
    res.status(500).json(errPayload(
      err?.message || "Failed to fetch PO timeline",
      "DB_ERROR",
      err?.stack
    ));
  }
});

export default router;

