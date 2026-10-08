import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' keeps asset links relative, so the build works under any GitHub Pages path (user.github.io/<repo>/)
export default defineConfig({ base: './', plugins: [react()] })
