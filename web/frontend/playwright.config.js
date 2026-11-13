import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 18080);
const dataDir = process.env.E2E_DATA_DIR || '.e2e-data';
const authState = '.auth/state.json';

export default defineConfig({
    testDir: './e2e',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        {
            name: 'setup',
            testMatch: /auth\.setup\.js/
        },
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], storageState: authState },
            dependencies: ['setup'],
            testIgnore: [/auth\.setup\.js/, /login\.spec\.js/]
        },
        {
            name: 'anonymous',
            use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } },
            dependencies: ['setup'],
            testMatch: /login\.spec\.js/
        }
    ],
    webServer: {
        command: 'bash e2e/start-server.sh',
        url: `http://127.0.0.1:${port}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
            ...process.env,
            E2E_PORT: String(port),
            E2E_DATA_DIR: dataDir,
            AUTHENTICATION_PASSWORD: 'e2e-password'
        }
    }
});
