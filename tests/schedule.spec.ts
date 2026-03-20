import { expect, test } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';
import { SchedulePage } from './pages/SchedulePage';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin1234';

async function loginAsAdmin(loginPage: LoginPage) {
  await loginPage.goto('/');
  await loginPage.fillUsername(ADMIN_USER);
  await loginPage.fillPassword(ADMIN_PASS);
  await loginPage.submit();
  await loginPage.expectLoggedIn();
}

test.describe('Schedule', () => {
  test.beforeEach(async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginAsAdmin(loginPage);
  });

  test('after login, schedule page shows', async ({ page }) => {
    const schedulePage = new SchedulePage(page);

    await schedulePage.expectTabsVisible();
    await schedulePage.expectDateDisplayed();
    await expect(page.locator('.schedule-wrap')).toBeVisible();
  });

  test('can switch NDT/MAT/OT tabs', async ({ page }) => {
    const schedulePage = new SchedulePage(page);

    await schedulePage.clickTab('NDT');
    await expect(page.locator('button.tab.ndt')).toHaveClass(/active/);

    await schedulePage.clickTab('MAT');
    await expect(page.locator('button.tab.mat')).toHaveClass(/active/);

    await schedulePage.clickTab('OT');
    await expect(page.locator('button.tab.ot')).toHaveClass(/active/);
  });

  test('date navigation prev/next works', async ({ page }) => {
    const schedulePage = new SchedulePage(page);
    const dateLocator = page.locator('.current-date');

    await schedulePage.expectDateDisplayed();
    const initial = (await dateLocator.textContent())?.trim() ?? '';

    await schedulePage.clickPrevDay();
    await expect(dateLocator).not.toHaveText(initial);

    await schedulePage.clickNextDay();
    await expect(dateLocator).toHaveText(initial);
  });

  test('page title/header visible', async ({ page }) => {
    await expect(page).toHaveTitle('전주E재활 시간표');
    await expect(page.locator('.header h1')).toContainText('전주E재활');
  });
});
