import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(WEB_DIR, "../..")

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, REPO_ROOT, "")
  const backendPort = env.PORT ?? "3000"
  const backendTarget = env.NIRI_PROXY_TARGET ?? `http://127.0.0.1:${backendPort}`

  return {
    envDir: REPO_ROOT,
    base: mode === "production" ? "/ui/" : "/",
    plugins: [react()],
    server: {
      host: true,
      proxy: {
        "/agents": backendTarget,
        "/health": backendTarget,
        "/trigger": backendTarget,
        "/chat": backendTarget,
        "/status": backendTarget,
        "/metrics": backendTarget,
      },
    },
    preview: {
      host: true,
    },
  }
})
