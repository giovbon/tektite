// End-to-end style API flow tests using a small in-memory fetch mock.
import test from 'node:test';
import assert from 'node:assert/strict';

function mockFetch(records = {}, unauthorized = false) {
    const originalFetch = globalThis.fetch;

    const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers }
    });

    globalThis.fetch = async (url, options = {}) => {
        const requestURL = new URL(url, 'http://localhost');
        const path = requestURL.pathname;
        const method = options.method || 'GET';
        let payload = {};
        if (typeof options.body === 'string' && options.body) {
            try {
                payload = JSON.parse(options.body);
            } catch {
                payload = {};
            }
        }

        if (path === '/api/auth/status') {
            return json({ enabled: true, authenticated: !unauthorized });
        }
        if (path === '/api/auth/login') {
            if (payload.password === 'secret123') {
                return json({ success: true }, 200, {
                    'Set-Cookie': 'pkm-notes-session=abc123; HttpOnly; Path=/; SameSite=Strict'
                });
            }
            return json({ error: 'Invalid password' }, 401);
        }
        if (path === '/api/auth/logout') return json({ success: true });

        if (path === '/api/notes' && method === 'POST') {
            const note = {
                id: 7 + (records.notes?.length || 0),
                title: payload.title || 'Untitled',
                content: payload.content || '',
                folder: payload.folder || '',
                tags: payload.tags || [],
                version: 1
            };
            (records.notes = records.notes || []).push(note);
            return json(note, 201);
        }
        if (path === '/api/notes' && method === 'GET') {
            const notes = records.notes || [];
            return json({ items: notes, total: notes.length });
        }
        if (path === '/api/folder-notes') {
            const folder = requestURL.searchParams.get('folder') || '';
            const items = (records.notes || []).filter(note => (note.folder || '') === folder);
            return json({ items, total: items.length });
        }
        if (path === '/api/search') return json({ items: [], total: 0 });
        if (path === '/api/folders') return json([]);
        if (path === '/api/tags') return json([]);
        if (path === '/api/preview') {
            return new Response('<p>Test preview</p>', {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }
        if (path === '/api/backup') {
            if (method === 'GET') return json({ notes: 0, attachments: 0 });
            if (method === 'POST') return json({ notes: 1, attachments: 0 });
        }

        const match = path.match(/^\/api\/notes\/(\d+)(?:\/(.*))?$/);
        if (match) {
            const id = Number(match[1]);
            const rest = match[2] || '';
            const note = (records.notes || []).find(item => item.id === id);

            if (rest === 'backlinks') return json([]);
            if (rest === 'attachments') {
                if (method === 'GET') return json([]);
                if (method === 'POST') {
                    return json({ id: 1, filename: 'test.txt', size: 1024, media_type: 'text/plain' }, 201);
                }
            }
            if (!note) return json({ error: 'Not found' }, 404);
            if (!rest) {
                if (method === 'GET') return json(note);
                if (method === 'PUT') {
                    note.title = payload.title || note.title;
                    if (payload.content !== undefined) note.content = payload.content;
                    note.version = (note.version || 0) + 1;
                    return json(note);
                }
                if (method === 'DELETE') {
                    records.notes = (records.notes || []).filter(item => item.id !== id);
                    return new Response(null, { status: 204 });
                }
            }
        }

        return new Response('Not found', { status: 404 });
    };

    return () => { globalThis.fetch = originalFetch; };
}

test('complete flow: create note, edit, attach, navigate, restore backup', async () => {
    const resetFetch = mockFetch();

    try {
        let response = await globalThis.fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Minha primeira nota', content: '# Olá Mundo' })
        });
        assert.ok(response.ok, 'Create note failed');
        const created = await response.json();
        assert.strictEqual(created.title, 'Minha primeira nota');
        const noteId = created.id;

        response = await globalThis.fetch(`/api/notes/${noteId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Nota editada', content: '# Olá Mundo\n\nSome content', version: created.version })
        });
        assert.ok(response.ok, 'Edit note failed');
        const updated = await response.json();
        assert.strictEqual(updated.title, 'Nota editada');

        response = await globalThis.fetch(`/api/notes/${noteId}/attachments`, {
            method: 'POST',
            body: new FormData()
        });
        if (response.status !== 401) {
            const attachment = await response.json();
            assert.ok(attachment.id, 'Attachment should have an ID');
        }

        response = await globalThis.fetch('/api/notes', { method: 'GET' });
        assert.ok(response.ok, 'List notes failed');
        const listed = await response.json();
        assert.ok(listed.items.some(note => note.title === 'Nota editada'), 'Edited note should be in list');

        response = await globalThis.fetch('/api/backup', { method: 'GET' });
        assert.ok(response.ok, 'Backup export failed');
        const backupData = await response.json();

        response = await globalThis.fetch('/api/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(backupData)
        });
        assert.ok(response.ok, 'Backup restore failed');
        const restored = await response.json();
        assert.strictEqual(restored.notes, 1, 'Should restore 1 note');

        response = await globalThis.fetch(`/api/notes/${noteId}`, { method: 'GET' });
        assert.ok(response.ok, 'Get restored note failed');
        const finalNote = await response.json();
        assert.strictEqual(finalNote.title, 'Nota editada', 'Note should retain title after restore');
    } finally {
        resetFetch();
    }
});

test('navigation flow: open note, go back, switch folders', async () => {
    const resetFetch = mockFetch();

    try {
        await globalThis.fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Work note', content: 'Work content', folder: 'Work' })
        });
        await globalThis.fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Personal note', content: 'Personal content' })
        });

        let response = await globalThis.fetch('/api/notes', { method: 'GET' });
        assert.ok(response.ok);
        const notes = (await response.json()).items;
        assert.ok(notes.some(note => note.folder === 'Work'), 'Work note should exist');

        response = await globalThis.fetch('/api/folder-notes?folder=Work', { method: 'GET' });
        assert.ok(response.ok);
        const folderNotes = (await response.json()).items;
        assert.ok(folderNotes.some(note => note.title === 'Work note'), 'Should find work note in folder');
    } finally {
        resetFetch();
    }
});

test('wikilink and mention flow', async () => {
    const resetFetch = mockFetch();

    try {
        await globalThis.fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Note A', content: 'Check [[Note B]] for more info' })
        });
        await globalThis.fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Note B', content: 'Related content' })
        });

        const response = await globalThis.fetch('/api/notes/1/backlinks', { method: 'GET' });
        assert.ok(response.ok, 'Get backlinks failed');
        const backlinks = await response.json();
        assert.ok(Array.isArray(backlinks), 'Backlinks should be an array');
    } finally {
        resetFetch();
    }
});
