import { expect, type Page } from '@playwright/test';

export type ScheduleTab = 'NDT' | 'MAT' | 'OT' | '본인';

export class SchedulePage {
  constructor(private readonly page: Page) {}

  async expectTabsVisible() {
    await expect(this.page.getByRole('button', { name: 'NDT' })).toBeVisible();
    await expect(this.page.getByRole('button', { name: 'MAT' })).toBeVisible();
    await expect(this.page.getByRole('button', { name: 'OT' })).toBeVisible();
    await expect(this.page.getByRole('button', { name: '본인' })).toBeVisible();
  }

  async clickTab(name: ScheduleTab) {
    await this.page.getByRole('button', { name }).click();
  }

  async clickNextDay() {
    await this.page.getByRole('button', { name: '▶' }).click();
  }

  async clickPrevDay() {
    await this.page.getByRole('button', { name: '◀' }).click();
  }

  async expectDateDisplayed() {
    const currentDate = this.page.locator('.current-date');
    await expect(currentDate).toBeVisible();
    await expect(currentDate).not.toHaveText('');
  }
}
