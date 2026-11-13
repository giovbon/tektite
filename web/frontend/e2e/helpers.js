import { expect } from '@playwright/test';

export function uniqueTitle(prefix) {
    return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function createNote(request, data) {
    const response = await request.post('/api/notes', { data });
    expect(response.ok()).toBeTruthy();
    return response.json();
}
