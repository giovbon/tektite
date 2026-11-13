import { test, expect } from '@playwright/test';
import { uniqueTitle } from './helpers.js';

test('creates a note, autosaves, survives reload and is searchable', async ({ page }) => {
    const title = uniqueTitle('Nota E2E');
    const content = '# Título\n\nConteúdo persistido.';

    await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
            window.__cspViolations.push(event.violatedDirective);
        });
    });
    await page.goto('/');
    await page.locator('#newNote').click();
    await expect(page.locator('#editorView')).toBeVisible();
    await page.locator('#noteTitle').fill(title);
    await page.locator('#noteContent').fill(content);
    await expect(page.locator('#saveStatus')).toHaveText(/Salvo automaticamente/);
    await expect(page).toHaveURL(/note=\d+/);
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

    await page.reload();
    await expect(page.locator('#noteTitle')).toHaveValue(title);
    await expect(page.locator('#noteContent')).toHaveValue(content);

    await page.locator('#homeButton').click();
    await page.locator('#searchInput').fill(title);
    await expect(page.locator('.note-card', { hasText: title })).toBeVisible();
});
