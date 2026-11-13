import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('renaming a note rewrites incoming wikilinks', async ({ page, request }) => {
    const target = await createNote(request, {
        title: uniqueTitle('Alvo'),
        content: 'nota alvo',
        folder: ''
    });
    const source = await createNote(request, {
        title: uniqueTitle('Fonte'),
        content: `Veja [[${target.title}]]`,
        folder: ''
    });

    await page.goto(`/?note=${target.id}`);
    await expect(page.locator('#noteTitle')).toHaveValue(target.title);

    const renamed = uniqueTitle('Renomeado');
    await page.locator('#noteTitle').fill(renamed);
    await expect(page.locator('#saveStatus')).toHaveText(/Salvo automaticamente/);

    const response = await request.get(`/api/notes/${source.id}`);
    expect(response.ok()).toBeTruthy();
    const note = await response.json();
    expect(note.content).toContain(`[[${renamed}]]`);
});

test('suggests headings after # inside a wikilink', async ({ page, request }) => {
    const target = await createNote(request, {
        title: uniqueTitle('Alvo'),
        content: '# Introdução\n\nTexto\n\n## Primeira Seção\n\nMais texto',
        folder: ''
    });
    const source = await createNote(request, {
        title: uniqueTitle('Fonte'),
        content: '',
        folder: ''
    });

    await page.goto(`/?note=${source.id}`);
    await page.locator('#noteContent').fill(`Veja [[${target.title}#`);

    const options = page.locator('#wikilinkAutocomplete .wikilink-option');
    await expect(options.first()).toContainText('Introdução');
    await expect(options.nth(1)).toContainText('Primeira Seção');
    await options.nth(1).click();
    await expect(page.locator('#noteContent')).toHaveValue(`Veja [[${target.title}#Primeira Seção]]`);
});

test('opens a heading link at the matching section', async ({ page, request }) => {
    const body = 'Parágrafo de preenchimento.\n\n'.repeat(40);
    const target = await createNote(request, {
        title: uniqueTitle('Alvo'),
        content: `# Topo\n\n${body}## Destino\n\nConteúdo final.`,
        folder: ''
    });
    const source = await createNote(request, {
        title: uniqueTitle('Fonte'),
        content: `Veja [[${target.title}#Destino]]`,
        folder: ''
    });

    await page.goto(`/?note=${source.id}`);
    await page.locator('#markdownPreview a', { hasText: `#Destino` }).click();
    await expect(page.locator('#noteTitle')).toHaveValue(target.title);
    await expect.poll(() => page.locator('#markdownPreview').evaluate(element => element.scrollTop))
        .toBeGreaterThan(0);
});
