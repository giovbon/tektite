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

test('table view reflects an attachment deletion immediately after returning from the editor', async ({ page, request }) => {
    const note = await createNote(request, {
        title: uniqueTitle('Anexo na tabela'),
        content: '',
        folder: ''
    });

    const form = new FormData();
    form.append('file', new Blob(['conteúdo'], { type: 'text/plain' }), 'apagar.txt');
    await request.post(`/api/notes/${note.id}/attachments`, { multipart: form });

    await page.goto('/');
    await page.locator('.mode-button[data-mode="table"]').click();

    const noteRow = page.locator('.tabulator-row.is-note-row', { hasText: note.title });
    await expect(noteRow).toBeVisible();
    await noteRow.locator('.tabulator-data-tree-control').click();

    const attachmentRow = page.locator('.tabulator-row.is-attachment-row', { hasText: 'apagar.txt' });
    await expect(attachmentRow).toBeVisible();

    await noteRow.locator('.table-note-link').click();
    await expect(page.locator('#noteTitle')).toHaveValue(note.title);

    await page.locator('#attachmentsButton').click();
    await expect(page.locator('#attachmentList')).toContainText('apagar.txt');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-delete-attachment]').click();
    await expect(page.locator('#attachmentsEmpty')).toBeVisible();

    await page.goBack();
    await expect(noteRow).toBeVisible();
    await expect(page.locator('.tabulator-row.is-attachment-row', { hasText: 'apagar.txt' })).toHaveCount(0);
    await expect(noteRow.locator('.table-note-sub')).toHaveText('sem anexos');
});
