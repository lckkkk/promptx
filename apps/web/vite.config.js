import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (id.includes('/@tiptap/') || id.includes('/prosemirror/')) {
            return 'vendor-tiptap'
          }

          if (id.includes('/lucide-vue-next/') || id.includes('/vue-draggable-plus/')) {
            return 'vendor-ui'
          }

          if (id.includes('/markdown-it/')) {
            return 'vendor-markdown'
          }

          if (id.includes('/vue-router/')) {
            return 'vendor-router'
          }

          return 'vendor-misc'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
})
