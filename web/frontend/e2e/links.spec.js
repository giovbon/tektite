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
