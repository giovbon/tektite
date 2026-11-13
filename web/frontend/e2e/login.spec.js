import { test, expect } from '@playwright/test';

test('rejects a wrong password and accepts the correct one', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\.html$/);

    await page.getByLabel('Senha').fill('senha-errada');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('#message')).toContainText(/invalid password/i);

    await page.getByLabel('Senha').fill('e2e-password');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL(/\/$|\/\?/);
    await expect(page.locator('#newNote')).toBeVisible();
});

test('redirects anonymous API calls to the login page', async ({ request }) => {
    const response = await request.get('/api/notes');
    expect(response.status()).toBe(401);
});
