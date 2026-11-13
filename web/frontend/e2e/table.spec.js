import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test.describe('Tabulator table mode', () => {
    test('tree expansion shows attachments with open/download actions', async ({ page, request }) => {
        const folder = uniqueTitle('AnexosTable');
        const note = await createNote(request, {
            title: uniqueTitle('Nota com anexos'),
            folder,
            content: 'Esta nota tem anexos.'
        });

        const form1 = new FormData();
        form1.append('file', new Blob(['conteúdo png'], { type: 'image/png' }), 'diagrama.png');
        await request.post(`/api/notes/${note.id}/attachments`, { multipart: form1 });

        const form2 = new FormData();
        form2.append('file', new Blob(['conteúdo pdf'], { type: 'application/pdf' }), 'relatorio.pdf');
        await request.post(`/api/notes/${note.id}/attachments`, { multipart: form2 });

        await page.goto('/');
        await page.locator('.mode-button[data-mode="table"]').click();
        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        const noteRow = page.locator('.tabulator-row.is-note-row', { hasText: 'Nota com anexos' });
        await expect(noteRow).toBeVisible();

        const expandButton = noteRow.locator('.tabulator-data-tree-control');
        await expandButton.click();
        await page.waitForTimeout(200);

        const attachmentRows = page.locator('.tabulator-row.is-attachment-row');
        await expect(attachmentRows).toHaveCount(2);

        await expect(attachmentRows.nth(0).locator('.table-file-name')).toContainText('diagrama.png');
        await expect(attachmentRows.nth(0).locator('.table-file-type')).toContainText('PNG');
        await expect(attachmentRows.nth(1).locator('.table-file-name')).toContainText('relatorio.pdf');
        await expect(attachmentRows.nth(1).locator('.table-file-type')).toContainText('PDF');

        await expect(attachmentRows.nth(0).locator('.table-action[title="Abrir anexo"]')).toBeVisible();
        await expect(attachmentRows.nth(0).locator('.table-action[title="Baixar anexo"]')).toBeVisible();
    });

    test('shows table with note rows', async ({ page, request }) => {
        const folder = uniqueTitle('ProjetosTable');
        await createNote(request, {
            title: uniqueTitle('Projeto A'),
            folder,
            content: 'Conteúdo.'
        });

        await page.goto('/');
        await page.locator('.mode-button[data-mode="table"]').click();
        await expect(page.locator('.mode-button[data-mode="table"]')).toHaveClass(/is-active/);
        await expect(page.locator('#tableView')).toBeVisible();

        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        // At least one note row visible
        const visibleRows = page.locator('.tabulator-row.is-note-row');
        await expect(visibleRows.first()).toBeVisible();
    });
});