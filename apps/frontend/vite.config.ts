import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'

export default defineConfig({
    plugins: [
        react(),
        monacoEditorPlugin.default({
            languageWorkers: ['editorWorkerService', 'json', 'css', 'html', 'typescript']
        })
    ],
    optimizeDeps: {
        include: ['monaco-editor/esm/vs/basic-languages/java/java', 'monaco-editor/esm/vs/language/typescript/tsMode']
    },
    define: {
        global: 'window'
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:8080',
            '/ws': {
                target: 'http://localhost:8080',
                ws: true
            }
        }
    }
})