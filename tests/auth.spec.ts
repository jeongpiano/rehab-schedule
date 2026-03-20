import { expect, test } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin1234';

test.describe('Auth', () => {
  test('login with valid creds -> app loads', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await loginPage.goto('/');
    await loginPage.fillUsername(ADMIN_USER);
    await loginPage.fillPassword(ADMIN_PASS);
    await loginPage.submit();

    await loginPage.expectLoggedIn();
  });

  test('login with wrong password -> error shown', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await loginPage.goto('/');
    await loginPage.fillUsername(ADMIN_USER);
    await loginPage.fillPassword('wrong-password');
    await loginPage.submit();

    await loginPage.expectError();
  });

  test('logout -> login page shown', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await loginPage.goto('/');
    await loginPage.fillUsername(ADMIN_USER);
    await loginPage.fillPassword(ADMIN_PASS);
    await loginPage.submit();
    await loginPage.expectLoggedIn();

    await page.locator('.user-name').click();
    await page.getByText('↩ 로그아웃').click();

    await expect(page.locator('.auth-container')).toBeVisible();
    await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
  });
});
