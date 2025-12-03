import { chromium } from '@playwright/test';
import { toError } from '@webpieces/core-util';

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
    try {
        const { browser, page } = await initializeBrowserAndLogin();
        await configureAllPackages(page);
        await finalizeBrowserSession(browser, page);
    } catch (err: any) {
        const error = toError(err);
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

async function initializeBrowserAndLogin() {
    const browser = await chromium.launch({
        headless: false,
        slowMo: 500,
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('🌐 Opening npm login page...');
    console.log('👉 Please log in to npm manually');

    await page.goto('https://www.npmjs.com/login');
    await waitForUserLogin(page);

    console.log('✅ Login detected! Starting to configure packages...\n');

    return { browser, page };
}

async function waitForUserLogin(page: any) {
    console.log('⏳ Waiting for you to log in...');
    await page.waitForSelector('[data-testid="user-menu"]', { timeout: 300000 });
}

async function configureAllPackages(page: any) {
    for (const packageName of packages) {
        console.log(`\n📦 Configuring: ${packageName}`);
        await configureSinglePackage(page, packageName);
        await page.waitForTimeout(2000);
    }
}

async function configureSinglePackage(page: any, packageName: string) {
    try {
        await navigateToPackageSettings(page, packageName);
        await attemptTrustedPublisherSetup(page, packageName);
        console.log(`   ✅ Completed: ${packageName}`);
    } catch (err: any) {
        const error = toError(err);
        console.error(`   ❌ Error configuring ${packageName}:`, error);
        await page.screenshot({ path: `npm-error-${packageName.replace('/', '-')}.png` });
    }
}

async function navigateToPackageSettings(page: any, packageName: string) {
    const settingsUrl = `https://www.npmjs.com/package/${packageName}/access`;
    console.log(`   Navigating to: ${settingsUrl}`);
    await page.goto(settingsUrl);
    await page.waitForLoadState('networkidle');
    console.log(`   Current URL: ${page.url()}`);
}

async function attemptTrustedPublisherSetup(page: any, packageName: string) {
    console.log('   Looking for Trusted Publishers section...');

    const addButton = page.locator('button', { hasText: /add.*trusted.*publisher/i });
    const buttonCount = await addButton.count();

    if (buttonCount > 0) {
        await setupTrustedPublisher(page, addButton);
    } else {
        await handleNoButtonFound(page, packageName);
    }
}

async function setupTrustedPublisher(page: any, addButton: any) {
    console.log('   ✅ Found "Add trusted publisher" button');
    await addButton.first().click();
    await page.waitForTimeout(1000);
    await fillGitHubActionsForm(page);
}

async function fillGitHubActionsForm(page: any) {
    console.log('   Selecting GitHub Actions as provider...');
    const githubOption = page.locator('text=/github.*actions/i');
    const githubCount = await githubOption.count();

    if (githubCount > 0) {
        await githubOption.first().click();
        await page.waitForTimeout(1000);
        await fillRepositoryDetails(page);
        await promptForManualReview(page);
    } else {
        console.log('   ⚠️  Could not find GitHub Actions option');
    }
}

async function fillRepositoryDetails(page: any) {
    console.log('   Filling in repository details...');

    await page.fill('input[name*="owner" i], input[placeholder*="owner" i]', GITHUB_OWNER);
    await page.fill('input[name*="repo" i], input[placeholder*="repo" i]', GITHUB_REPO);
    await page.fill('input[name*="workflow" i], input[placeholder*="workflow" i]', WORKFLOW_FILE);

    await fillEnvironmentNameIfPresent(page);

    console.log(`     Owner: ${GITHUB_OWNER}`);
    console.log(`     Repository: ${GITHUB_REPO}`);
    console.log(`     Workflow: ${WORKFLOW_FILE}`);
    console.log(`     Environment: ${ENVIRONMENT_NAME || '(blank)'}`);
}

async function fillEnvironmentNameIfPresent(page: any) {
    const envInput = page.locator(
        'input[name*="environment" i], input[placeholder*="environment" i]',
    );
    const envCount = await envInput.count();
    if (envCount > 0) {
        await envInput.first().fill(ENVIRONMENT_NAME);
    }
}

async function promptForManualReview(page: any) {
    console.log('   Looking for submit button...');
    const submitButton = page.locator(
        'button[type="submit"], button:has-text("Save"), button:has-text("Add")',
    );
    const submitCount = await submitButton.count();

    if (submitCount > 0) {
        console.log('   ⏸️  PAUSING - Please review the form and click Save manually');
        console.log('   Press Enter in the console when ready to continue...');
        await page.waitForTimeout(30000);
    }
}

async function handleNoButtonFound(page: any, packageName: string) {
    console.log('   ℹ️  Trusted publisher might already be configured or button not found');
    console.log('   📸 Taking screenshot for debugging...');
    await page.screenshot({ path: `npm-status-${packageName.replace('/', '-')}.png` });
}

async function finalizeBrowserSession(browser: any, page: any) {
    console.log('\n\n🎉 All packages processed!');
    console.log('📸 Check the screenshots for any issues');
    console.log('\n⏸️  Browser will stay open for 60 seconds for you to verify...');

    await page.waitForTimeout(60000);
    await browser.close();
    console.log('\n✅ Done! Browser closed.');
}

setupTrustedPublishers().catch(console.error);
