// Login page controller. Kept in a separate file so the app can serve a
// Content-Security-Policy without allowing inline scripts.
const form = document.querySelector('#loginForm');
const password = document.querySelector('#password');
const message = document.querySelector('#message');

fetch('/api/auth/status')
    .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    })
    .then(status => {
        if (!status.enabled || status.authenticated) location.replace('/');
    })
    .catch(error => {
        message.textContent = `Não foi possível verificar o acesso: ${error.message}`;
    });

form.addEventListener('submit', async event => {
    event.preventDefault();
    message.textContent = '';
    form.querySelector('button').disabled = true;
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password.value })
        });
        if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        location.replace('/');
    } catch (error) {
        message.textContent = error.message;
        password.focus();
    } finally {
        form.querySelector('button').disabled = false;
    }
});
