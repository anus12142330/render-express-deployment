// /server/jobs/container-tracking.js
import cron from 'node-cron';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
import db from '../db.js';

const DUBAI_TRADE_URL = 'https://dpwdtjb2.dubaitrade.ae/pmisc1/containerenqaction.do';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const clean = (v) => (v ? String(v).replace(/\u00A0/g, '').trim() : null) || null;

/** ---------------------------
 *  SCRAPER (no Puppeteer)
 *  --------------------------*/
export async function fetchContainerDataFromDubaiTrade(containerNo) {
  try {
    if (!containerNo || containerNo.length < 4) return null;

    // Dubai Trade expects the container WITHOUT the last check digit
    const containerForApi = containerNo.slice(0, -1).toUpperCase();

    const res = await fetch(DUBAI_TRADE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Origin': 'https://dpwdtjb2.dubaitrade.ae',
        'Referer': DUBAI_TRADE_URL,
        'Accept': 'text/html,application/xhtml+xml',
      },
      body: new URLSearchParams({ containerNumber: containerForApi }),
    });

    const html = await res.text();

    if (!res.ok) {
      console.error('[DT] Non-200:', res.status, res.statusText);
      return null;
    }
    if (!html || html.length < 500) {
      console.error('[DT] Very short HTML returned:', html?.slice(0, 200));
      return null;
    }

    const $ = cheerio.load(html);

    // helpers
    const getTextByLabel = (label) => {
      const el = $('td.labelLeft, td.label')
        .filter((_, e) => $(e).text().trim().includes(label))
        .first();
      const val = el.next();
      return clean(val.text());
    };

    const findDischargeLoadTable = () => {
      let found = null;
      $('table').each((_, tbl) => {
        if (found) return;
        const firstRow = $(tbl).find('tr').first();
        const headers = firstRow.find('td, th').map((__, h) => $(h).text().toLowerCase().trim()).get();
        if (headers.length >= 3 && /discharge/.test(headers[1]) && /load/.test(headers[2])) {
          found = tbl;
        }
      });
      return found ? $(found) : null;
    };

    const getPairedFromDLTable = (tbl, label) => {
      if (!tbl) return [null, null];
      let row = null;
      tbl.find('tr').each((_, tr) => {
        const first = $(tr).find('td').first().text().replace(/\u00A0/g, '').trim();
        if (first === label) {
          row = $(tr);
          return false;
        }
      });
      if (!row) return [null, null];
      const tds = row.find('td');
      return [clean($(tds[1]).text()), clean($(tds[2]).text())];
    };

    const getContainerMoves = () => {
      const wanted = ['line','port','desig','move','category','status','date','from location','vehicle','eir no','haulier','terminal'];
      let movesTable = null;

      $('table').each((_, t) => {
        if (movesTable) return;
        const hdr = $(t).find('tr').first().find('td, th').map((__, th) => $(th).text().toLowerCase().trim()).get();
        if (wanted.every((w, i) => (hdr[i] || '').startsWith(w))) {
          movesTable = $(t);
        }
      });
      if (!movesTable) return [];

      const rows = movesTable.find('tr').slice(1);
      const out = [];
      rows.each((_, tr) => {
        const td = $(tr).find('td');
        if (td.length !== 12) return; // only real data rows

        const obj = {
          line: clean($(td[0]).text()),
          port: clean($(td[1]).text()),
          desig: clean($(td[2]).text()),
          move: clean($(td[3]).text()),
          category: clean($(td[4]).text()),
          status: clean($(td[5]).text()),
          date: clean($(td[6]).text()),
          from_location: clean($(td[7]).text()),
          vehicle: clean($(td[8]).text()),
          eir_no: clean($(td[9]).text()),
          haulier: clean($(td[10]).text()),
          terminal: clean($(td[11]).text()),
        };

        const joined = Object.values(obj).join(' ').toLowerCase();
        if ((!obj.move && !obj.date) || joined.includes('container number:')) return;
        out.push(obj);
      });
      return out;
    };

    // extract
    const dlTable = findDischargeLoadTable();

    const [dischargeVessel, loadVessel]           = getPairedFromDLTable(dlTable, 'Vessel Name');
    const [dischargeVoyage, loadVoyage]           = getPairedFromDLTable(dlTable, 'Voyage Number');
    const [dischargeDesignation, loadDesignation] = getPairedFromDLTable(dlTable, 'Designation');
    const [dischargeDate, loadDate]               = getPairedFromDLTable(dlTable, 'Discharge/Loaded Date');
    const [dischargeDocs, loadDocs]               = getPairedFromDLTable(dlTable, 'Document Processed');

    const data = {
      containerNumber: getTextByLabel('Container Number:'),
      status:          getTextByLabel('Status:'),
      portName:        getTextByLabel('Port Name:'),
      terminal:        getTextByLabel('Terminal:'),
      containerLength: getTextByLabel('Container Length:'),
      weightInTonnes:  getTextByLabel('Weight (in Tonnes):'),
      isoCode:         getTextByLabel('ISO Code:'),
      isoType:         getTextByLabel('ISO Type:'),
      heavyDutyFlag:   getTextByLabel('Heavy Duty Flag:'),

      dischargeVessel, loadVessel,
      dischargeVoyage, loadVoyage,
      dischargeDesignation, loadDesignation,
      dischargeDate, loadDate,
      dischargeDocs, loadDocs,

      containerMoves: getContainerMoves(),
    };

    if (!data.containerNumber) {
      console.error('[DT] Could not find data on page.');
      return null;
    }

    return data;
  } catch (err) {
    console.error('[DT] fetch error:', err);
    return null;
  }
}

/** ---------------------------
 *  DB UPSERT
 *  --------------------------*/
export async function saveOrUpdateContainerData(
  dbConnection,
  containerNo,
  data,
  shipmentId = null,
  shipmentContainerId = null
) {
  if (!data || !data.containerNumber) {
    throw new Error('Invalid data provided to saveOrUpdateContainerData');
  }

  // Generate the current timestamp in the correct timezone.
  const nowInDubai = dayjs().tz(process.env.TZ || 'Asia/Dubai').format('YYYY-MM-DD HH:mm:ss');

  const [statusResult] = await dbConnection.query(
    `
    INSERT INTO dubai_trade_container_status (
      container_no, shipment_id, shipment_container_id,
      status, location, port_name, container_length, weight_in_tonnes, iso_code, iso_type, heavy_duty_flag,
      vessel, load_vessel, voyage, load_voyage,
      eta, discharge_date, load_date,
      discharge_designation, load_designation, discharge_docs, load_docs,
      raw_data, last_fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      shipment_id = COALESCE(VALUES(shipment_id), shipment_id),
      shipment_container_id = COALESCE(VALUES(shipment_container_id), shipment_container_id),
      status = VALUES(status), location = VALUES(location), port_name = VALUES(port_name),
      container_length = VALUES(container_length), weight_in_tonnes = VALUES(weight_in_tonnes),
      iso_code = VALUES(iso_code), iso_type = VALUES(iso_type), heavy_duty_flag = VALUES(heavy_duty_flag),
      vessel = VALUES(vessel), load_vessel = VALUES(load_vessel), voyage = VALUES(voyage), load_voyage = VALUES(load_voyage),
      eta = VALUES(eta), discharge_date = VALUES(discharge_date), load_date = VALUES(load_date),
      discharge_designation = VALUES(discharge_designation), load_designation = VALUES(load_designation),
      discharge_docs = VALUES(discharge_docs), load_docs = VALUES(load_docs),
      raw_data = VALUES(raw_data), last_fetched_at = ?
    `,
    [
      containerNo, shipmentId, shipmentContainerId,
      data.status, data.terminal, data.portName, data.containerLength, data.weightInTonnes,
      data.isoCode, data.isoType, data.heavyDutyFlag,
      data.dischargeVessel, data.loadVessel, data.dischargeVoyage, data.loadVoyage,
      data.dischargeDate, data.dischargeDate, data.loadDate,
      data.dischargeDesignation, data.loadDesignation, data.dischargeDocs, data.loadDocs,
      JSON.stringify(data), nowInDubai, nowInDubai // Pass the timestamp for both INSERT and UPDATE
    ]
  );

  // insertId is set only on INSERT; if DUPLICATE, fetch id:
  let statusId = statusResult.insertId;
  if (!statusId || statusId === 0) {
    const [[row]] = await dbConnection.query(
      'SELECT id FROM dubai_trade_container_status WHERE container_no = ? AND shipment_container_id = ?',
      [containerNo, shipmentContainerId]
    );
    if (row) statusId = row.id;
  }

  if (statusId && data.containerMoves?.length) {
    await dbConnection.query(
      'DELETE FROM dubai_trade_container_moves WHERE dubai_trade_status_id = ?',
      [statusId]
    );
    const movesValues = data.containerMoves.map((m) => [
      statusId, m.line, m.port, m.desig, m.move, m.category,
      m.status, m.date, m.from_location, m.vehicle, m.eir_no, m.haulier, m.terminal,
    ]);
    await dbConnection.query(
      'INSERT INTO dubai_trade_container_moves (dubai_trade_status_id, line, port, desig, move, category, status, date, from_location, vehicle, eir_no, haulier, terminal) VALUES ?',
      [movesValues]
    );
  }

  return statusId;
}

/** ---------------------------
 *  NIGHTLY CRON (22:00 Asia/Dubai)
 *  --------------------------*/
export const runContainerTrackingJob = async () => {
  console.log('Starting container tracking cron job…');
  const pool = db.promise();

  try {
    // include shipment_container.id for saveOrUpdate
    const [containers] = await pool.query(`
      SELECT DISTINCT sc.id AS shipment_container_id, sc.container_no, sc.shipment_id
      FROM shipment_container sc
      JOIN shipment s ON sc.shipment_id = s.id
      JOIN purchase_orders po ON s.po_id = po.id
      WHERE po.mode_shipment_id = 1 -- Sea freight
        AND s.shipment_stage_id >= 4 -- Sailed
        AND s.shipment_stage_id < 6  -- Before Cleared
        AND sc.container_no IS NOT NULL AND sc.container_no != ''
    `);

    if (!containers.length) {
      console.log('No containers to track.');
      return;
    }

    for (const c of containers) {
      const data = await fetchContainerDataFromDubaiTrade(c.container_no);
      if (data?.containerNumber) {
        await saveOrUpdateContainerData(pool, c.container_no, data, c.shipment_id, c.shipment_container_id);
        console.log(`Updated DB for ${c.container_no}`);
      } else {
        console.warn(`No data parsed for ${c.container_no}`);
      }
    }
  } catch (err) {
    console.error('Cron error:', err);
  }

  console.log('Container tracking cron job finished.');
};

cron.schedule('0 22 * * *', runContainerTrackingJob, {
  scheduled: true,
  timezone: process.env.TZ || 'Asia/Dubai',
});
