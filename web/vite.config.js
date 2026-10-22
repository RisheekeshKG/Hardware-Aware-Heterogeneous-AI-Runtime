import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Rust build output in src-tauri/target is locked while compiling; don't watch it.
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
})
