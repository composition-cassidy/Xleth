import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(here, 'harness'),
  server: {
    host: '127.0.0.1',
    port: 5189,
    strictPort: true,
    fs: { allow: [path.resolve(here, '../..')] },
  },
})
