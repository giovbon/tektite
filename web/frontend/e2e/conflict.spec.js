import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('keeps the overwrite path when a stale tab saves', async ({ page, context, request }) => {
    const note = await createNote(request, {
        title: uniqueTitle('Conflito'),
        content: 'versão inicial',
        folder: ''
    });
    const secondPage = await context.newPage();

    await page.goto(`/?note=${note.id}`);
    await secondPage.goto(`/?note=${note.id}`);
    await expect(page.locator('#noteTitle')).toHaveValue(note.title);
    await expect(secondPage.locator('#noteTitle')).toHaveValue(note.title);

    await page.locator('#noteContent').fill('primeira versão');
    await expect(page.locator('#saveStatus')).toHaveText(/Salvo automaticamente/);

    const dialogPromise = secondPage.waitForEvent('dialog');
    await secondPage.locator('#noteContent').fill('segunda versão');
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain('outra aba');
    await dialog.dismiss();

    await expect(secondPage.locator('#saveStatus')).toHaveText(/Salvo automaticamente/);
    const response = await request.get(`/api/notes/${note.id}`);
    const saved = await response.json();
    expect(saved.content).toBe('segunda versão');
    await secondPage.close();
});
