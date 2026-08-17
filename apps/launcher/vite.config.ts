import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

// `electron/main.ts` lê a configuração via `process.env.VITE_*`, mas nada
// colocava esses valores em `process.env`: o Vite carrega `.env` para
// `import.meta.env` (renderer), não para o processo Node do main, e o app
// empacotado nem sequer tem um `.env` do lado. Resultado: CLIENT_ID, SERVER_IP,
// API_PORT e DIST_REPO caíam sempre no fallback vazio/localhost, então login,
// fila, verificação de mods e update nunca podiam funcionar fora da máquina de
// desenvolvimento.
//
// A correção é substituir esses acessos em tempo de build (`define`), que é o
// único mecanismo que sobrevive ao empacotamento.
//
// VITE_DISCORD_CLIENT_SECRET NÃO entra nessa lista de propósito: qualquer valor
// embutido aqui viaja dentro do instalador e pode ser extraído por qualquer
// jogador. A troca de code por token passou a ser feita pelo painel web, que é
// quem guarda o secret — ver docs/technical/LAUNCHER_DISTRIBUTION.md.
const INLINED_ENV = [
  'VITE_DISCORD_CLIENT_ID',
  'VITE_DISCORD_REDIRECT_URI',
  'VITE_SERVER_IP',
  'VITE_SERVER_PORT',
  'VITE_API_PORT',
  'VITE_GITHUB_DIST_REPO',
  'VITE_CLIENT_UPDATE_CHANNEL',
  'VITE_MODS_UPDATE_CHANNEL',
  'VITE_UPDATE_PUBLIC_KEYS',
  'VITE_PANEL_URL'
] as const

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_')

  const mainDefine: Record<string, string> = {}
  for (const key of INLINED_ENV) {
    mainDefine[`process.env.${key}`] = JSON.stringify(env[key] ?? '')
  }

  const electronBuild = (entry: string, extra: Record<string, unknown> = {}) => ({
    entry,
    ...extra,
    vite: {
      define: mainDefine,
      build: {
        outDir: 'dist-electron',
        minify: mode === 'production',
      },
    },
  })

  return {
    plugins: [
      react(),
      electron([
        electronBuild('electron/main.ts'),
        electronBuild('electron/preload.ts', {
          onstart(options: { reload: () => void }) {
            options.reload()
          },
        }),
      ]),
      renderer(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      emptyOutDir: true,
    },
  }
})
