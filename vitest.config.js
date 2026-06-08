import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js'],
        setupFiles: ['./tests/setup.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'json-summary'],
            include: ['js/**/*.js'],
            exclude: ['js/libs/**', 'js/update/**'],
            thresholds: {
                lines: 25,
                functions: 25,
                branches: 26,
                statements: 25
            }
        }
    }
});
