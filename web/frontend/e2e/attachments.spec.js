import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('uploads, persists and deletes an attachment', async ({ page, request }) => {
    const note = await createNote(request, {
        title: uniqueTitle('Anexo'),
        content: '',
        folder: ''
    });

    await page.goto(`/?note=${note.id}`);
    await expect(page.locator('#noteTitle')).toHaveValue(note.title);

    await page.locator('#attachmentsButton').click();
    await page.locator('#attachmentInput').setInputFiles({
        name: 'e2e.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('conteúdo do anexo')
    });
    await expect(page.locator('#attachmentList')).toContainText('e2e.txt');
    await expect(page.locator('#noteContent')).toHaveValue(/e2e\.txt/);
    await expect(page.locator('#saveStatus')).toHaveText(/Salvo automaticamente/);

    await page.reload();
    await expect(page.locator('#noteTitle')).toHaveValue(note.title);
    await page.locator('#attachmentsButton').click();
    await expect(page.locator('#attachmentList')).toContainText('e2e.txt');

    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-delete-attachment]').click();
    await expect(page.locator('#attachmentsEmpty')).toBeVisible();
    await expect(page.locator('#attachmentList')).not.toContainText('e2e.txt');
});
