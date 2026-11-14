import { test, expect } from '@playwright/test';
import { uniqueTitle } from './helpers.js';

async function selectMarkdownFiles(page, files) {
    await page.goto('/');
    await page.locator('#settingsButton').click();
    await expect(page.locator('#panelTitle')).toHaveText('Configurações');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#importMarkdownNotes').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(files);
}

test('imports multiple Markdown files as notes in the root from settings', async ({ page, request }) => {
    const firstTitle = uniqueTitle('Markdown import one');
    const secondTitle = uniqueTitle('Markdown import two');
    const firstContent = '# Primeira nota\n\nConteúdo original.';
    const secondContent = '## Segunda nota\n\nOutra linha.';

    await selectMarkdownFiles(page, [
        { name: `${firstTitle}.md`, mimeType: 'text/markdown', buffer: Buffer.from(firstContent) },
        { name: `${secondTitle}.md`, mimeType: 'text/markdown', buffer: Buffer.from(secondContent) }
    ]);

    await expect(page.locator('#appMessage')).toContainText('2 notas Markdown importadas na raiz');
    const pageData = await request.get('/api/notes?limit=100&offset=0');
    expect(pageData.ok()).toBeTruthy();
    const { items } = await pageData.json();
    const importedNotes = items.filter(note => [firstTitle, secondTitle].includes(note.title));
    expect(importedNotes).toHaveLength(2);
    expect(importedNotes.every(note => note.folder === '')).toBeTruthy();

    const byTitle = new Map(importedNotes.map(note => [note.title, note]));
    const [firstResponse, secondResponse] = await Promise.all([
        request.get(`/api/notes/${byTitle.get(firstTitle).id}`),
        request.get(`/api/notes/${byTitle.get(secondTitle).id}`)
    ]);
    expect(firstResponse.ok()).toBeTruthy();
    expect(secondResponse.ok()).toBeTruthy();
    expect((await firstResponse.json()).content).toBe(firstContent);
    expect((await secondResponse.json()).content).toBe(secondContent);
});

test('continues importing valid Markdown files when a selected file is invalid', async ({ page, request }) => {
    const title = uniqueTitle('Markdown import valid');

    await selectMarkdownFiles(page, [
        { name: `${title}.md`, mimeType: 'text/markdown', buffer: Buffer.from('# Nota válida') },
        { name: 'not-markdown.txt', mimeType: 'text/plain', buffer: Buffer.from('Ignorado') }
    ]);

    await expect(page.locator('#appMessage')).toContainText('Importadas 1 de 2 notas Markdown');
    await expect(page.locator('#appMessage')).toContainText('not-markdown.txt');
    const search = await request.get(`/api/search?q=${encodeURIComponent(title)}&mode=title`);
    expect(search.ok()).toBeTruthy();
    expect((await search.json()).items.map(note => note.title)).toContain(title);
});
