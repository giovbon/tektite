import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { test as setup, expect } from '@playwright/test';

const authState = '.auth/state.json';

setup('authenticate with the configured password', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\.html$/);
    await page.getByLabel('Senha').fill('e2e-password');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL(/\/$|\/\?/);
    await expect(page.locator('#newNote')).toBeVisible();

    mkdirSync(dirname(authState), { recursive: true });
    await page.context().storageState({ path: authState });
});
