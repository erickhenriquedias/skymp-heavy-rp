# AUTH-003 — Handoff de sessão do launcher para o SkyMP

Data: **2026-08-16**.

## Problema corrigido

O launcher escrevia três representações incompatíveis:

- `skymp_config.json.session = ticket:<sessão>`;
- `clientSettings.gameData.launcherTicket = <sessão>`;
- `clientSettings.gameData.profileId = últimos dígitos do Discord`.

O cliente SkyMP pinado não lê `skymp_config.json` nem `launcherTicket` para autenticação. Em `AuthService.onAuthNeeded()`, um `profileId` inteiro ativa o caminho offline. O servidor de produção usa `offlineMode: false` e aceita apenas `gameData.session`, então o contrato não fechava.

## Contrato atual

```text
Game API emite game session opaca
  → launcher valida tamanho/formato básico
  → skymp5-client-settings.txt.gameData.session
  → AuthService transforma em AuthGameData.remote
  → SkympClient guarda no storage da conexão
  → loginWithSkympIo { gameData: { session } }
  → LoginSystem resolve no Master API
  → Master devolve accountId autoritativo
```

O launcher remove `profileId`, `launcherTicket` e `token` legados. Sessão remota tem precedência defensiva caso settings antigas ainda contenham `profileId`.

## Patch upstream

O suporte a sessão externa nas settings não existe no pin `d85f18d808f877401c4e20484d2c2f6f73cf9caa`. O patch está registrado em:

```text
patches/skymp/launcher-session-settings-auth.patch
patches/manifest.json
```

Ele também impede `LoginSystem` de registrar `JSON.stringify(gameData)` em falha, pois isso expunha o bearer. O log mantém somente `hasSession` e `hasProfileId`.

## Evidência automatizada

- `apps/launcher/electron/auth-settings.test.mjs`: serialização, remoção de campos legados e validação.
- `patches/launcher-session-auth.contract.test.mjs`: transpila o `authModel.ts` real e prova launcher → `AuthGameData.remote`.
- `skymp/gamemode/core/auth-boundary.test.js`: impede retorno do profile derivado e vazamento no log.
- `git apply --check`: patch aplica limpo no pin.
- Builds TypeScript/webpack do cliente e servidor SkyMP.

## Limite de validação

O contrato, o typecheck e os bundles foram validados. Ainda falta o gate runtime com servidor SkyMP, Master API e dois clientes Skyrim reais. A sessão de jogo atual é reutilizável até expirar/revogar para permitir reconnect; transformá-la em connection grant rotativo de uso único pertence à fase de account/admission e não foi fingido como concluído aqui.

