import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';

const PO_PDF_DIR = path.resolve("uploads/purchaseorder/pdf");
fs.mkdirSync(PO_PDF_DIR, { recursive: true });

/**
 * Generates a PDF from a given URL using Puppeteer.
 * @param {string} url The full URL to render into a PDF.
 * @param {string} fileName The desired name for the output PDF file.
 * @param {object} [options] Additional options, like session cookies.
 * @returns {Promise<string>} The relative path to the saved PDF file.
 */
async function generatePdf(url, fileName, options = {}) {
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

        // Define the full path for the output file
        const pdfPath = path.join(PO_PDF_DIR, fileName);

        // Generate PDF
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20px',
                right: '20px',
                bottom: '20px',
                left: '20px'
            }
        });

        // Return the relative path for storing in the database
        return `uploads/purchaseorder/pdf/${fileName}`;

    } catch (error) {
        console.error(`PDF generation failed for URL: ${url}`, error);
        throw new Error('Failed to generate PDF.');
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

export default generatePdf;
