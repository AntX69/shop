import { chromium } from 'playwright';

async function verify() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  page.on('pageerror', err => {
    errors.push(err.message);
  });

  console.log('Navigating to http://localhost:3000 ...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // Check if PIN login is present
  const pinInput = page.locator('input[type="password"]');
  if (await pinInput.count() > 0) {
    console.log('Entering Owner PIN 1111 ...');
    await pinInput.fill('1111');
    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();
    await page.waitForTimeout(1000);
  }

  // Look for Settings link/button
  console.log('Navigating to Settings view ...');
  const settingsBtn = page.getByRole('button', { name: /პარამეტრები/i }).or(page.locator('button:has-text("პარამეტრები")'));
  if (await settingsBtn.count() > 0) {
    await settingsBtn.first().click();
    await page.waitForTimeout(1000);
  }

  // Check for Backup tab
  const backupTab = page.locator('button:has-text("სარეზერვო ასლები")');
  console.log('Backup tab exists:', await backupTab.count() > 0);

  // Check for one-click backup button
  const createBackupBtn = page.locator('button:has-text("ერთიანი ასლის შექმნა")');
  console.log('Create backup button exists:', await createBackupBtn.count() > 0);

  // Take screenshot
  await page.screenshot({ path: '/tmp/settings_view.png', fullPage: true });
  console.log('Screenshot saved to /tmp/settings_view.png');

  console.log('Console Errors found:', errors.length);
  if (errors.length > 0) {
    console.log('Errors:', errors);
  }

  await browser.close();
}

verify().catch(e => {
  console.error('Verification failed:', e);
  process.exit(1);
});
