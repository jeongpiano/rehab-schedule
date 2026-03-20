import { expect, type Page } from '@playwright/test';

export class LoginPage {
  constructor(private readonly page: Page) {}

  async goto(path = '/') {
    await this.page.goto(path);
  }

  async fillUsername(username: string) {
    await this.page.locator('#username').fill(username);
  }

  async fillPassword(password: string) {
    await this.page.locator('#password').fill(password);
  }

  async submit() {
    await this.page.getByRole('button', { name: '로그인' }).click();
  }

  async expectError() {
    const error = this.page.locator('#auth-error');
    await expect(error).toBeVisible();
    await expect(error).not.toHaveText('');
  }

  async expectLoggedIn() {
    await expect(this.page.locator('.auth-container')).toHaveCount(0);
    await expect(this.page.locator('.header')).toBeVisible();
  }
}
