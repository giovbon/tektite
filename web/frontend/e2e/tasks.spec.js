import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('loads task markers saved on the server for every browser', async ({ page, request }) => {
    const markers = ['TODO', 'LATER'];
    const save = await request.put('/api/task-markers', { data: { markers } });
    expect(save.ok()).toBeTruthy();
    try {
        const title = uniqueTitle('LATER E2E');
        await createNote(request, { title, content: 'LATER: testar marcador personalizado' });

        const markersLoaded = page.waitForResponse(response =>
            response.url().endsWith('/api/task-markers') && response.request().method() === 'GET'
        );
        await page.goto('/');
        await markersLoaded;
        await page.locator('#settingsButton').click();
        await expect(page.locator('#taskMarkersInput')).toHaveValue('TODO, LATER');
        await page.locator('#tasksButton').click();

        const item = page.locator('#workspacePanel .task-item', { hasText: 'testar marcador personalizado' });
        await expect(item).toBeVisible();
        await expect(item.locator('.task-marker')).toHaveText('LATER');

        await page.locator('#settingsButton').click();
        await page.locator('#taskMarkersInput').fill('TODO, LATER, BLOCKED');
        await page.locator('#saveTaskMarkers').click();
        await expect(page.locator('#appMessage')).toContainText('Marcadores de tarefa atualizados');

        const settings = await request.get('/api/task-markers');
        expect(await settings.json()).toEqual({ markers: ['TODO', 'LATER', 'BLOCKED'] });
    } finally {
        await request.put('/api/task-markers', { data: { markers: ['TODO', 'FIXME', 'HACK', 'XXX', 'BUG', 'NOTE'] } });
    }
});

test('lists task markers in the sidebar and opens the matching line', async ({ page, request }) => {
    const folder = `Projetos ${Date.now()}/Subpasta`;
    expect((await request.post('/api/folders', { data: { path: folder } })).ok()).toBeTruthy();
    const title = uniqueTitle('Tarefas E2E');
    const content = [
        '# Tarefas',
        '',
        ...Array.from({ length: 30 }, (_, index) => `linha de preenchimento ${index + 1}`),
        '',
        'TODO: revisar a proposta',
        'FIXME: corrigir o cálculo'
    ].join('\n');
    await createNote(request, { title, content, folder });

    await page.goto('/');
    await page.locator('#tasksButton').click();

    const panel = page.locator('#workspacePanel');
    await expect(panel.locator('.tasks-summary')).toBeVisible();
    const item = panel.locator('.task-item', { hasText: 'revisar a proposta' });
    await expect(item).toBeVisible();
    await expect(item.locator('.task-marker')).toHaveText('TODO');

    await item.click();
    await expect(page.locator('#noteTitle')).toHaveValue(title);
    await expect(page.locator('#noteContent')).toHaveValue(content);
    await expect(page.locator('#noteContentHighlight .md-task-marker', { hasText: 'TODO' })).toBeVisible();

    // The click also navigates the sidebar to the note folder.
    await expect(panel).toHaveAttribute('data-panel', 'files');
    await expect(panel.locator('.tree-folder.is-selected')).toContainText(folder.split('/').at(-1));
    await expect(page.locator('#currentFolder')).toHaveText(folder);

    const scrollTop = await page.locator('#noteContent').evaluate(element => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#markdownPreview').evaluate(element => element.scrollTop))
        .toBeGreaterThan(0);
});

test('opens a task at the marker in reading mode', async ({ page, request }) => {
    const title = uniqueTitle('Tarefas leitura E2E');
    const content = [
        '# Tarefas',
        '',
        ...Array.from({ length: 40 }, (_, index) => `linha de preenchimento ${index + 1}\n`),
        'TODO: revisar no modo leitura'
    ].join('\n');
    await createNote(request, { title, content });
    await page.addInitScript(() => localStorage.setItem('editorMode', 'preview'));

    await page.goto('/');
    await page.locator('#tasksButton').click();
    await page.locator('#workspacePanel .task-item', { hasText: 'revisar no modo leitura' }).click();

    await expect(page.locator('.editor-workspace')).toHaveAttribute('data-editor-mode', 'preview');
    await expect(page.locator('#markdownPreview')).toContainText('revisar no modo leitura');
    await expect.poll(() => page.locator('#markdownPreview').evaluate(element => element.scrollTop))
        .toBeGreaterThan(0);
});
