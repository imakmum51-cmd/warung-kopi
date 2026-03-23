import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto('http://localhost:5000');

console.log('Browser terbuka di http://localhost:5000');
console.log('Tekan Ctrl+C untuk menutup...');

// Keep browser open
await new Promise(() => {});
