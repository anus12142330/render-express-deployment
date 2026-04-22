import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const ACCENT = '#1b5e20';
const BORDER = '#c8e6c9';

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function money(n, currency = '') {
    const v = Number(n || 0);
    const t = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${currency} ${t}` : t;
}

/**
 * Split shipping address for PDF: address lines 1+2 on one row; city / state / country on the next.
 * Uses newline-separated text from `shipping_address` (or enriched vendor address).
 */
function formatShippingAddressForPdf(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { line1: '', line2: '' };
    const parts = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return { line1: '', line2: '' };
    if (parts.length === 1) return { line1: parts[0], line2: '' };
    const line1 = [parts[0], parts[1]].filter(Boolean).join(' ');
    const line2 = parts.length > 2 ? parts.slice(2).join(', ') : '';
    return { line1, line2 };
}

function tryLogoDataUrl(logoPath) {
    if (!logoPath || typeof logoPath !== 'string') return null;
    const rel = logoPath.replace(/^\//, '');
    const full = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
    try {
        if (!fs.existsSync(full)) return null;
        const buf = fs.readFileSync(full);
        let ext = path.extname(full).slice(1).toLowerCase();
        if (ext === 'jpg') ext = 'jpeg';
        if (!['png', 'jpeg', 'gif', 'webp'].includes(ext)) ext = 'png';
        return `data:image/${ext};base64,${buf.toString('base64')}`;
    } catch {
        return null;
    }
}

/**
 * Build HTML for a Delivery Order (A5), styled similarly to the sales order PDF layout.
 */
export function buildDeliveryOrderHtml({
    company,
    header,
    dispatch,
    lines,
    dispatchLabel
}) {
    const companyName = escapeHtml(company?.name || header.company_name || 'Company');
    const companyAddr = escapeHtml(company?.full_address || '').replace(/\n/g, '<br/>');
    const trn = company?.trn_no ? escapeHtml(String(company.trn_no)) : '';
    const logoSrc = company?.base64logo || tryLogoDataUrl(company?.logo) || null;

    const orderNo = escapeHtml(header.order_no || '');
    const addr = formatShippingAddressForPdf(header.shipping_address || '');
    const shipLine1 = escapeHtml(addr.line1);
    const shipLine2 = escapeHtml(addr.line2);
    const dispDate = dispatch.dispatched_at
        ? new Date(dispatch.dispatched_at).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric'
          })
        : '—';

    const rowsHtml = lines
        .map(
            (row, i) => `
      <tr>
        <td class="c-sn">${i + 1}</td>
        <td class="c-desc">
          <div class="desc-title">${row.titleHtml || row.descriptionHtml || '—'}</div>
          ${row.packingHtml ? `<div class="desc-packing">${row.packingHtml}</div>` : ''}
        </td>
        <td class="c-qty">${money(row.qty)}<div class="uom">${escapeHtml(row.uom || '')}</div></td>
      </tr>`
        )
        .join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    @page { size: A5 portrait; margin: 10mm; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
    }
    body {
      font-family: Helvetica, Arial, sans-serif;
      font-size: 9pt;
      color: #222;
    }
    /* One full A5 viewport height so signature row can sit at the bottom */
    .wrap {
      position: relative;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      padding-bottom: 2mm;
    }
    .main-flow {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .watermark {
      position: fixed;
      left: 50%;
      top: 45%;
      transform: translate(-50%, -50%) rotate(-12deg);
      font-size: 48pt;
      color: rgba(0,80,40,0.06);
      font-weight: 700;
      z-index: 0;
      pointer-events: none;
    }
    .top {
      display: flex;
      justify-content: flex-start;
      align-items: flex-start;
      margin-bottom: 8px;
      position: relative;
      z-index: 1;
    }
    .co-block {
      max-width: 58%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      text-align: left;
    }
    .logo { max-height: 44px; max-width: 130px; object-fit: contain; margin-bottom: 4px; }
    .co-name { font-weight: 700; font-size: 10pt; margin-bottom: 4px; }
    .co-addr { font-size: 8pt; line-height: 1.25; color: #333; }
    .desc-title { font-weight: 600; font-size: 8pt; color: #222; }
    .desc-packing {
      font-size: 6.5pt;
      color: #4d4d4d;
      margin-top: 3px;
      line-height: 1.25;
      font-weight: 400;
    }
    .banner-wrap {
      display: flex;
      justify-content: center;
      margin: 10px 0 12px;
      position: relative;
      z-index: 1;
    }
    .banner {
      display: inline-block;
      background: ${ACCENT};
      color: #fff;
      text-align: center;
      padding: 6px 20px;
      font-weight: 700;
      letter-spacing: 0.5px;
      font-size: 11pt;
      width: fit-content;
      max-width: 85%;
    }
    .meta { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 9pt; position: relative; z-index: 1; }
    .meta b { color: #b71c1c; }
    .party { margin-bottom: 10px; border: 1px solid ${BORDER}; padding: 8px; background: #fafefa; position: relative; z-index: 1; }
    .party label { font-weight: 700; font-size: 8pt; color: #555; display: block; margin-bottom: 4px; }
    .dispatch-info { font-size: 8pt; margin-top: 6px; color: #444; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; position: relative; z-index: 1; }
    th {
      background: ${ACCENT};
      color: #fff;
      padding: 6px 4px;
      font-size: 7.5pt;
      text-align: left;
      border: 1px solid ${ACCENT};
    }
    td {
      border: 1px solid #ddd;
      padding: 5px 4px;
      vertical-align: top;
      font-size: 8pt;
    }
    .c-sn { width: 8%; text-align: center; }
    .c-desc { width: 62%; }
    .c-qty { width: 30%; text-align: right; }
    .uom { font-size: 7pt; color: #666; margin-top: 2px; }
    .sign {
      margin-top: auto;
      padding-top: 8mm;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 8px;
      font-size: 7pt;
      position: relative;
      z-index: 1;
      flex-shrink: 0;
    }
    .sign-box {
      flex: 1;
      text-align: center;
      padding-top: 6px;
      border-top: 1px solid #888;
      color: #333;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="watermark">${companyName.slice(0, 12)}</div>
    <div class="main-flow">
    <div class="top">
      <div class="co-block">
        ${logoSrc ? `<img class="logo" src="${logoSrc}" alt="" />` : ''}
        <div class="co-name">${companyName}</div>
        <div class="co-addr">${companyAddr || '—'}</div>
        ${trn ? `<div style="margin-top:4px;font-size:8pt;">TRN: ${trn}</div>` : ''}
      </div>
    </div>
    <div class="banner-wrap">
      <div class="banner">DELIVERY ORDER</div>
    </div>
    <div class="meta">
      <div><strong>No:</strong> <b>DO-${orderNo}-${escapeHtml(dispatchLabel || '')}</b></div>
      <div><strong>Date:</strong> ${escapeHtml(dispDate)}</div>
    </div>
    <div class="party">
      <label>Delivery address</label>
      <div style="line-height:1.35;">${shipLine1 || '—'}</div>
      ${shipLine2 ? `<div style="margin-top:4px;line-height:1.35;">${shipLine2}</div>` : ''}
      <div class="dispatch-info">
        <strong>Shipment:</strong> #${escapeHtml(String(dispatchLabel || ''))} &nbsp;|&nbsp;
        <strong>Vehicle:</strong> ${escapeHtml(dispatch.vehicle_no || '—')} &nbsp;|&nbsp;
        <strong>Driver:</strong> ${escapeHtml(dispatch.driver_name || '—')}
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th class="c-sn">S/N</th>
          <th class="c-desc">DESCRIPTION</th>
          <th class="c-qty">QTY</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
    </div>
    <div class="sign">
      <div class="sign-box">Prepared by</div>
      <div class="sign-box">Delivered by</div>
      <div class="sign-box">Received by</div>
      <div class="sign-box">${companyName}</div>
    </div>
  </div>
</body>
</html>`;
}

export async function htmlToA5PdfBuffer(html) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        // A5 ≈ 420×595pt — helps flex footer sit at bottom of one page
        await page.setViewport({ width: 420, height: 595, deviceScaleFactor: 1 });
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const buf = await page.pdf({
            format: 'A5',
            printBackground: true,
            margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' }
        });
        return Buffer.from(buf);
    } finally {
        if (browser) await browser.close();
    }
}

export { escapeHtml, money };
