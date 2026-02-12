const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const INVOICE_PDF_DIR = path.resolve("uploads/ar-invoices/pdf");
fs.mkdirSync(INVOICE_PDF_DIR, { recursive: true });

/**
 * Generates a PDF for customer invoice from a given URL using Puppeteer.
 * @param {string} url The full URL to render into a PDF.
 * @param {string} fileName The desired name for the output PDF file.
 * @param {object} [options] Additional options, like session cookies.
 * @returns {Promise<string>} The relative path to the saved PDF file.
 */
async function generateInvoicePdf(url, fileName, options = {}) {
    let browser = null;
    try {
        // Launch Puppeteer
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Necessary for running in some environments
        });

        const page = await browser.newPage();

        // --- Set Authentication Cookie if provided ---
        if (options.sessionCookie) {
            const { name, value, domain } = options.sessionCookie;
            await page.setCookie({
                name,
                value,
                domain, // Use the domain from the cookie
                httpOnly: true,
            });
        }

        // Navigate to the URL
        await page.goto(url, {
            waitUntil: 'networkidle0', // Wait for network activity to cease
        });

        // Wait for PDF viewer to render (react-pdf needs time to render)
        await page.waitForTimeout(3000); // Wait 3 seconds for PDF to render

        // Wait for PDF viewer element to be present
        try {
            await page.waitForSelector('iframe[title="react-pdf"]', { timeout: 10000 });
            // Wait a bit more for PDF content to load inside iframe
            await page.waitForTimeout(2000);
        } catch (e) {
            console.warn('PDF viewer iframe not found, proceeding anyway...');
        }

        // Define the full path for the output file
        const pdfPath = path.join(INVOICE_PDF_DIR, fileName);

        // Generate PDF
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '0px',
                right: '0px',
                bottom: '0px',
                left: '0px'
            }
        });

        // Return the relative path for storing in the database
        return `uploads/ar-invoices/pdf/${fileName}`;

    } catch (error) {
        console.error(`PDF generation failed for URL: ${url}`, error);
        throw new Error('Failed to generate PDF.');
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

module.exports = generateInvoicePdf;

