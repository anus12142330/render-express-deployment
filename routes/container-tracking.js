import cron from 'node-cron';
import puppeteer from 'puppeteer';
import db from '../db.js'; // Correct path to the db connection file

const DUBAI_TRADE_URL = 'https://dpwdtjb2.dubaitrade.ae/pmisc1/containerenqaction.do';

/**
 * Fetches container details from the Dubai Trade website.
 * This is a placeholder and needs to be implemented based on the website's structure.
 * @param {string} containerNo - The container number to search for.
 * @returns {Promise<object|null>} - The scraped data or null on failure.
 */
export async function fetchContainerDataFromDubaiTrade(containerNo) {
    let browser = null;
    try {
        // For production, you might need to specify the path to Chrome/Chromium
        // and add '--no-sandbox' for Linux environments.
        browser = await puppeteer.launch({
            headless: true, // Use 'new' for newer versions, or true. Set to false for debugging.
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // The Dubai Trade portal expects the container number WITHOUT the last check digit.
        const containerForApi = containerNo.slice(0, -1);

        // Replicate the PHP cURL POST request directly.
        // This is more reliable than interacting with the form UI.
        await page.evaluate((url, container) => {
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = url;
            form.innerHTML = `<input type="hidden" name="containerNumber" value="${container.toUpperCase()}">`;
            document.body.appendChild(form);
            form.submit();
        }, DUBAI_TRADE_URL, containerForApi);
        await page.waitForNavigation({ waitUntil: 'networkidle0' });

       const scrapedData = await page.evaluate(() => {
  const clean = (v) => (v ? v.replace(/\u00A0/g, '').trim() : null) || null;

  // ---- simple key:value fields
  const getTextByLabel = (label) => {
    const el = Array.from(document.querySelectorAll('td.labelLeft, td.label'))
      .find(e => e.textContent.trim().includes(label));
    return el?.nextElementSibling ? clean(el.nextElementSibling.textContent) : null;
  };

  // ---- locate the Discharge/Load table by its header cells
  const findDischargeLoadTable = () => {
    const allTables = Array.from(document.querySelectorAll('table'));
    for (const tbl of allTables) {
      const hdr = tbl.querySelector('tr');
      if (!hdr) continue;
      const tds = hdr.querySelectorAll('td, th');
      // header row should contain ... | Discharge | Load
      if (tds.length >= 3 &&
          /discharge/i.test(tds[1].textContent) &&
          /load/i.test(tds[2].textContent)) {
        return tbl;
      }
    }
    return null;
  };

  // ---- from the Discharge/Load table, read paired values by the left label
  const getPairedFromDLTable = (tbl, label) => {
    if (!tbl) return [null, null];
    const row = Array.from(tbl.querySelectorAll('tr')).find(tr => {
      const first = tr.querySelector('td');
      return first && first.textContent.replace(/\u00A0/g, '').trim() === label;
    });
    if (!row) return [null, null];
    const cells = row.querySelectorAll('td');
    return [clean(cells[1]?.innerText), clean(cells[2]?.innerText)];
  };

  // ---- Container Moves: grab the table that follows the "Container Moves Details" title row
  const getContainerMoves = () => {
  const clean = (v) => (v ? v.replace(/\u00A0/g, '').trim() : null) || null;

  // Find the table whose first row matches the exact moves headers
  const headerWanted = [
    'line','port','desig','move','category','status','date',
    'from location','vehicle','eir no','haulier','terminal'
  ];

  const candidateTables = Array.from(document.querySelectorAll('table'));
  let movesTable = null;

  for (const t of candidateTables) {
    const hdrCells = Array.from(t.querySelectorAll('tr:first-child td, tr:first-child th'))
      .map(el => el.textContent.replace(/\u00A0/g, '').trim().toLowerCase());
    if (headerWanted.every((h, i) => (hdrCells[i] || '').startsWith(h))) {
      movesTable = t;
      break;
    }
  }
  if (!movesTable) return [];

  // Read body rows; only accept rows with 12 <td>s (the real grid)
  const rows = Array.from(movesTable.querySelectorAll('tr')).slice(1);
  const moves = rows.map(tr => {
    const td = tr.querySelectorAll('td');
    if (td.length !== 12) return null; // reject merged/summary rows

    const obj = {
      line: clean(td[0]?.innerText),
      port: clean(td[1]?.innerText),
      desig: clean(td[2]?.innerText),
      move: clean(td[3]?.innerText),
      category: clean(td[4]?.innerText),
      status: clean(td[5]?.innerText),
      date: clean(td[6]?.innerText),
      from_location: clean(td[7]?.innerText),
      vehicle: clean(td[8]?.innerText),
      eir_no: clean(td[9]?.innerText),
      haulier: clean(td[10]?.innerText),
      terminal: clean(td[11]?.innerText),
    };

    // drop empty rows or any accidental summary text
    const joined = Object.values(obj).join(' ').toLowerCase();
    if ((!obj.move && !obj.date) || joined.includes('container number:')) return null;

    return obj;
  }).filter(Boolean);

  return moves;
};

  // ---- do the extraction
  const dlTable = findDischargeLoadTable();

  const [dischargeVessel, loadVessel]           = getPairedFromDLTable(dlTable, 'Vessel Name');
  const [dischargeVoyage, loadVoyage]           = getPairedFromDLTable(dlTable, 'Voyage Number');
  const [dischargeDesignation, loadDesignation] = getPairedFromDLTable(dlTable, 'Designation');
  const [dischargeDate, loadDate]               = getPairedFromDLTable(dlTable, 'Discharge/Loaded Date');
  const [dischargeDocs, loadDocs]               = getPairedFromDLTable(dlTable, 'Document Processed');

  return {
    // summary
    containerNumber: getTextByLabel('Container Number:'),
    status:          getTextByLabel('Status:'),
    portName:        getTextByLabel('Port Name:'),
    terminal:        getTextByLabel('Terminal:'),
    containerLength: getTextByLabel('Container Length:'),
    weightInTonnes:  getTextByLabel('Weight (in Tonnes):'),
    isoCode:         getTextByLabel('ISO Code:'),
    isoType:         getTextByLabel('ISO Type:'),
    heavyDutyFlag:   getTextByLabel('Heavy Duty Flag:'),

    // discharge / load (now correctly scoped)
    dischargeVessel, loadVessel,
    dischargeVoyage, loadVoyage,
    dischargeDesignation, loadDesignation,
    dischargeDate, loadDate,
    dischargeDocs, loadDocs,

    // moves table
    containerMoves: getContainerMoves(),
  };
});
        // Check if scraping was successful
        if (!scrapedData.containerNumber) {
            console.log(`No data found for container ${containerNo}.`);
            return null;
        }

        console.log(`Successfully scraped data for ${containerNo}:`, scrapedData);
        return scrapedData;

    } catch (error) {
        console.error(`Failed to fetch data for container ${containerNo}:`, error);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

/**
 * Saves or updates the scraped container data to the database.
 * @param {object} dbConnection - A mysql2 connection object.
 * @param {string} containerNo - The container number.
 * @param {object} data - The scraped data object from fetchContainerDataFromDubaiTrade.
 * @param {number|null} shipmentId - The associated shipment_id, if known.
 * @param {number|null} shipmentContainerId - The associated shipment_container_id, if known.
 * @returns {Promise<number>} - The ID of the inserted/updated status record.
 */
export async function saveOrUpdateContainerData(dbConnection, containerNo, data, shipmentId = null, shipmentContainerId = null) {
    if (!data || !data.containerNumber) {
        throw new Error("Invalid data provided to saveOrUpdateContainerData");
    }

    const [statusResult] = await dbConnection.query(`
        INSERT INTO dubai_trade_container_status (
            container_no, shipment_id, shipment_container_id, status, location, port_name, container_length, weight_in_tonnes, iso_code, iso_type, heavy_duty_flag,
            vessel, load_vessel, voyage, load_voyage,
            eta, discharge_date, load_date,
            discharge_designation, load_designation, discharge_docs, load_docs,
            raw_data, last_fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
            shipment_id = COALESCE(VALUES(shipment_id), shipment_id), shipment_container_id = COALESCE(VALUES(shipment_container_id), shipment_container_id),
            status = VALUES(status), location = VALUES(location), port_name = VALUES(port_name), container_length = VALUES(container_length),
            weight_in_tonnes = VALUES(weight_in_tonnes), iso_code = VALUES(iso_code), iso_type = VALUES(iso_type),
            heavy_duty_flag = VALUES(heavy_duty_flag), vessel = VALUES(vessel), load_vessel = VALUES(load_vessel),
            voyage = VALUES(voyage), load_voyage = VALUES(load_voyage), eta = VALUES(eta),
            discharge_date = VALUES(discharge_date), load_date = VALUES(load_date),
            discharge_designation = VALUES(discharge_designation), load_designation = VALUES(load_designation),
            discharge_docs = VALUES(discharge_docs), load_docs = VALUES(load_docs),
            raw_data = VALUES(raw_data), last_fetched_at = NOW()
    `, [
        containerNo, shipmentId, shipmentContainerId, data.status, data.terminal, data.portName, data.containerLength, data.weightInTonnes, data.isoCode, data.isoType, data.heavyDutyFlag,
        data.dischargeVessel, data.loadVessel, data.dischargeVoyage, data.loadVoyage,
        data.dischargeDate, data.dischargeDate, data.loadDate,
        data.dischargeDesignation, data.loadDesignation, data.dischargeDocs, data.loadDocs,
        JSON.stringify(data)
    ]);

    // The insertId is only available on INSERT. On UPDATE, we need to find the ID.
    let statusId = statusResult.insertId;
    if (!statusId || statusId === 0) {
        // On an UPDATE, insertId is 0, so we must fetch the ID manually.
        const [[row]] = await dbConnection.query('SELECT id FROM dubai_trade_container_status WHERE container_no = ? AND shipment_container_id = ?', [containerNo, shipmentContainerId]);
        if (row) {
            statusId = row.id;
        }
    }

    // Clear old moves and insert new ones
    if (statusId && data.containerMoves && data.containerMoves.length > 0) {
        await dbConnection.query('DELETE FROM dubai_trade_container_moves WHERE dubai_trade_status_id = ?', [statusId]);
        const movesValues = data.containerMoves.map(move => [
            statusId, move.line, move.port, move.desig, move.move, move.category,
            move.status, move.date, move.from_location, move.vehicle, move.eir_no,
            move.haulier, move.terminal
        ]);
        await dbConnection.query(`
            INSERT INTO dubai_trade_container_moves (dubai_trade_status_id, line, port, desig, move, category, status, date, from_location, vehicle, eir_no, haulier, terminal) VALUES ?
        `, [movesValues]);
    }

    return statusId;
}

/**
 * The main job function to be executed by the cron scheduler.
 */
export const runContainerTrackingJob = async () => {
    console.log('Starting container tracking cron job...');
    const conn = await db.promise();

    try {
        // 1. Get all unique container numbers for SEA shipments between Sailed (4) and Cleared (6)
        const [containers] = await conn.query(`
            SELECT DISTINCT sc.container_no, sc.shipment_id
            FROM shipment_container sc
            JOIN shipment s ON sc.shipment_id = s.id
            JOIN purchase_orders po ON s.po_id = po.id
            WHERE 
                po.mode_shipment_id = 1 -- Sea freight only
                AND s.shipment_stage_id >= 4 -- Sailed
                AND s.shipment_stage_id < 6  -- Before Cleared
                AND sc.container_no IS NOT NULL AND sc.container_no != ''
        `);

        if (containers.length === 0) {
            console.log('No containers to track.');
            return;
        }

        console.log(`Found ${containers.length} containers to track.`);

        for (const container of containers) {
            const data = await fetchContainerDataFromDubaiTrade(container.container_no);

            if (data && data.containerNumber) {
                await saveOrUpdateContainerData(conn, container.container_no, data, container.shipment_id, container.id);
                console.log(`Successfully updated DB for container ${container.container_no}`);
            }
        }
    } catch (error) {
        console.error('Error during container tracking cron job:', error);
    }
    console.log('Container tracking cron job finished.');
};

// Schedule the job to run at 10 PM every night.
cron.schedule('0 22 * * *', runContainerTrackingJob, {
    scheduled: true,
    timezone: "Asia/Dubai" // Set to your server's timezone
});
