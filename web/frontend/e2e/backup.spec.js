import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('exports a backup and restores it through the settings panel', async ({ page, request }) => {
    const title = uniqueTitle('Backup');
    await createNote(request, { title, content: 'marcador de backup', folder: '' });

    await page.goto('/');
    await page.locator('#settingsButton').click();
    await expect(page.locator('#panelTitle')).toHaveText('Configurações');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportBackup').click();
    const download = await downloadPromise;
    const archivePath = await download.path();
    expect(archivePath).toBeTruthy();

    page.on('dialog', dialog => dialog.accept());
    await page.locator('#backupInput').setInputFiles(archivePath);
    await expect(page).toHaveURL(/\/$|\/\?$/);
    await expect(page.locator('#searchInput')).toBeVisible();

    await page.locator('#searchInput').fill(title);
    await expect(page.locator('.note-card', { hasText: title })).toBeVisible();
});
