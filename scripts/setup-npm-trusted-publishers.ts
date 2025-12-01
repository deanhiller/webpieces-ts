import { chromium } from '@playwright/test';

const packages = [
  '@webpieces/core-context',
  '@webpieces/core-meta',
  '@webpieces/core-util',
  '@webpieces/http-api',
  '@webpieces/http-filters',
  '@webpieces/http-routing',
  '@webpieces/http-client',
  '@webpieces/http-server',
  '@webpieces/dev-config',
  // Umbrella packages
  '@webpieces/server',
  '@webpieces/client',
  '@webpieces/rules',
];

const GITHUB_OWNER = 'deanhiller';
const GITHUB_REPO = 'webpieces-ts';
const WORKFLOW_FILE = 'release.yml';
const ENVIRONMENT_NAME = ''; // Leave blank - we don't use GitHub environments

async function setupTrustedPublishers() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500 // Slow down actions so you can see what's happening
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('🌐 Opening npm login page...');
  console.log('👉 Please log in to npm manually');

  // Navigate to npm login
  await page.goto('https://www.npmjs.com/login');

  // Wait for user to log in (check for presence of user menu)
  console.log('⏳ Waiting for you to log in...');
  await page.waitForSelector('[data-testid="user-menu"]', { timeout: 300000 }); // 5 min timeout

  console.log('✅ Login detected! Starting to configure packages...\n');

  for (const packageName of packages) {
    console.log(`\n📦 Configuring: ${packageName}`);

    try {
      // Navigate to package settings
      const settingsUrl = `https://www.npmjs.com/package/${packageName}/access`;
      console.log(`   Navigating to: ${settingsUrl}`);
      await page.goto(settingsUrl);

      await page.waitForLoadState('networkidle');

      // Check if we're already on the right page
      const currentUrl = page.url();
      console.log(`   Current URL: ${currentUrl}`);

      // Look for "Trusted publishers" or "Publishing access" section
      console.log('   Looking for Trusted Publishers section...');

      // Try to find and click "Add trusted publisher" button
      const addButton = page.locator('button', { hasText: /add.*trusted.*publisher/i });
      const buttonCount = await addButton.count();

      if (buttonCount > 0) {
        console.log('   ✅ Found "Add trusted publisher" button');
        await addButton.first().click();
        await page.waitForTimeout(1000);

        // Select GitHub Actions provider
        console.log('   Selecting GitHub Actions as provider...');
        const githubOption = page.locator('text=/github.*actions/i');
        const githubCount = await githubOption.count();

        if (githubCount > 0) {
          await githubOption.first().click();
          await page.waitForTimeout(1000);

          // Fill in the form
          console.log('   Filling in repository details...');

          // Look for input fields
          await page.fill('input[name*="owner" i], input[placeholder*="owner" i]', GITHUB_OWNER);
          await page.fill('input[name*="repo" i], input[placeholder*="repo" i]', GITHUB_REPO);
          await page.fill('input[name*="workflow" i], input[placeholder*="workflow" i]', WORKFLOW_FILE);

          // Environment is optional - leave blank if not using GitHub environments
          const envInput = page.locator('input[name*="environment" i], input[placeholder*="environment" i]');
          const envCount = await envInput.count();
          if (envCount > 0) {
            await envInput.first().fill(ENVIRONMENT_NAME);
          }

          console.log(`     Owner: ${GITHUB_OWNER}`);
          console.log(`     Repository: ${GITHUB_REPO}`);
          console.log(`     Workflow: ${WORKFLOW_FILE}`);
          console.log(`     Environment: ${ENVIRONMENT_NAME || '(blank)'}`);

          // Look for submit/save button
          console.log('   Looking for submit button...');
          const submitButton = page.locator('button[type="submit"], button:has-text("Save"), button:has-text("Add")');
          const submitCount = await submitButton.count();

          if (submitCount > 0) {
            console.log('   ⏸️  PAUSING - Please review the form and click Save manually');
            console.log('   Press Enter in the console when ready to continue...');
            await page.waitForTimeout(30000); // Wait 30 seconds for manual review
          }
        } else {
          console.log('   ⚠️  Could not find GitHub Actions option');
          console.log('   📸 Taking screenshot for debugging...');
          await page.screenshot({ path: `npm-debug-${packageName.replace('/', '-')}.png` });
        }
      } else {
        console.log('   ℹ️  Trusted publisher might already be configured or button not found');
        console.log('   📸 Taking screenshot for debugging...');
        await page.screenshot({ path: `npm-status-${packageName.replace('/', '-')}.png` });
      }

      console.log(`   ✅ Completed: ${packageName}`);

    } catch (error) {
      console.error(`   ❌ Error configuring ${packageName}:`, error);
      await page.screenshot({ path: `npm-error-${packageName.replace('/', '-')}.png` });
    }

    // Small delay between packages
    await page.waitForTimeout(2000);
  }

  console.log('\n\n🎉 All packages processed!');
  console.log('📸 Check the screenshots for any issues');
  console.log('\n⏸️  Browser will stay open for 60 seconds for you to verify...');

  await page.waitForTimeout(60000);

  await browser.close();
  console.log('\n✅ Done! Browser closed.');
}

setupTrustedPublishers().catch(console.error);
