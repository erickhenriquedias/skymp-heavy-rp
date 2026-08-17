# Roadmap proposto a partir da pesquisa de forks

Este documento **não substitui** `SKYMP_RP_DEVELOPMENT_PLAN.md`. É uma proposta de sequência e gates. Nenhum módulo PARKED deve ser registrado como consequência automática desta pesquisa.

## Dependências

```text
AUTH -> CHARACTER -> IDENTITY
                  -> TRANSACTION/AUDIT -> FACTION -> PROPERTY
                                      -> TRADE -> ECONOMY -> JOBS -> CRAFTING
OPS/MODPACK e VOICE podem avançar em paralelo, sem ativar gameplay PARKED.
```

## P0 — segurança e invariantes

### AUTH-001 — Inventariar trust boundaries de identidade

- **Objetivo:** mapear todo input de `profileId`, account, session, character slot, role e staff level.
- **Dependências:** nenhuma.
- **Arquivos prováveis:** `whitelist.js`, `phase0-basic.js`, `apps/web/server.js`, `apps/game-api/server.js`, launcher.
- **Referência externa:** F02K directory auth/session handoff.
- **Risco:** alto; caminhos implícitos podem escapar da busca estática.
- **Pronto:** diagrama e lista de cada emissor, validador e consumidor; produção não depende de client-supplied `profileId`.
- **Testes:** spoof, missing/negative/huge ID, offline-only guard e staff escalation.

### AUTH-002 — Especificar ticket opaco v1

- **Objetivo:** contrato com subject interno, character slot, audience, iat/exp, nonce, key id e versão.
- **Dependências:** AUTH-001.
- **Arquivos prováveis:** nova documentação de contrato; web/game-api/launcher posteriormente.
- **Referência externa:** F02K Ed25519, canonical request e session TTL.
- **Risco:** alto; clock skew e key rotation.
- **Pronto:** threat model, canonical encoding, TTL, one-time/reuse policy e redaction definidos.
- **Testes:** vectors válidos/inválidos, alteração de claim, audience errada, expiração e chave antiga.

### AUTH-003 — Implementar validador server-side

- **Objetivo:** resolver sessão para account/character sem confiar no cliente.
- **Dependências:** AUTH-002.
- **Arquivos prováveis:** `whitelist.js`, módulo auth dedicado, `apps/web/server.js`.
- **Referência externa:** F02K directory connector/storage; adaptar para MariaDB/mysql2.
- **Risco:** crítico; lockout ou bypass.
- **Pronto:** fail-closed, rotação de chave, métricas e logs sem segredo.
- **Testes:** assinatura, revogação, DB indisponível, replay concorrente e reconnect.

### AUTH-004 — Suite de abuso de sessão

- **Objetivo:** impedir regressões de spoof/replay.
- **Dependências:** AUTH-003.
- **Arquivos prováveis:** testes de gamemode/web/launcher e CI.
- **Referência externa:** F02K nonce/timestamp/token hashing.
- **Risco:** médio.
- **Pronto:** suite em CI e artefato local explicitamente separado de produção.
- **Testes:** duplicação de packet, stale ticket, slot trocado, token em log e 100 reconnects.

### MOD-001 — Manifesto canônico v2

> **Implementado no código em 16/08/2026; aguardando validação operacional:**
> contrato compartilhado estrito, paths canônicos `Data/...`, enumeração
> recursiva, tamanho e SHA-256 por stream, categorias, load order obrigatória,
> política de extras e colisões case-insensitive. Reprodutibilidade entre duas
> máquinas e arquivos reais grandes continua na matriz de testes.

- **Objetivo:** definir paths, ordem, tamanho, SHA-256, masters, build id e assinatura.
- **Dependências:** nenhuma.
- **Arquivos prováveis:** `apps/game-api/modsManifest.js`, generator e docs.
- **Referência externa:** F02K `canonical-json.ts`, `modcollection.ts`.
- **Risco:** path normalization cross-platform.
- **Pronto:** mesma entrada gera bytes idênticos em duas máquinas.
- **Testes:** ordem diferente, Unicode, path traversal, case collision e arquivo grande.

### MOD-002 — Gerador assinado

> **Implementado no código em 16/08/2026; aguardando release real:** o envelope
> Ed25519 cobre `client`, `mods` e `parity`, com validade, sequência monotônica,
> key id/rotação e chave privada somente no ambiente do gerador. O game-api e o
> launcher verificam o manifesto de paridade antes de consumir o payload.

- **Objetivo:** produzir hashes e assinatura sem expor chave de release.
- **Dependências:** MOD-001.
- **Arquivos prováveis:** `apps/game-api/scripts/generate-mods-manifest.js`, CI release.
- **Referência externa:** F02K client pack/buildtool.
- **Risco:** crítico se chave vazar.
- **Pronto:** signing isolado, key id/rotation e notices.
- **Testes:** tamper, missing file, duplicate plugin e chave errada.

### MOD-003 — Verificação no launcher

> **Implementado no código em 16/08/2026; aguardando runtime empacotado:** o
> launcher autentica os três feeds, aplica validade/anti-downgrade, bloqueia o
> boot por recibo e oferece repair incremental transacional. Só baixa entradas
> redistribuíveis divergentes, exige confirmação acima de 500 MB, recusa links e
> extras, revalida tudo após o commit e faz rollback se o resultado não fechar.
> Cancelamento cooperativo foi implementado em 16/08/2026 para update de
> cliente, update de mods e repair: aborta transporte/staging antes da
> publicação e é deliberadamente recusado durante commit. Quarentena de extras
> continua pendente; hoje eles são diagnosticados e exigem correção manual.

- **Objetivo:** bloquear boot com pack inválido e mostrar reparo seguro.
- **Dependências:** MOD-002.
- **Arquivos prováveis:** `apps/launcher/electron/main.ts`, preload/types/UI.
- **Referência externa:** F02K auth/load-order verification.
- **Risco:** alto; falso positivo impede acesso.
- **Pronto:** verify-before-launch, progresso, cancelamento e diagnóstico redigido.
- **Testes:** truncamento, hash errado, symlink/junction, read-only e falta de espaço.

### MOD-004 — Rollback e recuperação do pack

- **Objetivo:** atualização atômica e recuperação após crash.
- **Dependências:** MOD-003.
- **Arquivos prováveis:** launcher Electron e release workflow.
- **Referência externa:** F02K pack/doctor.
- **Risco:** alto; perda de arquivos do usuário.
- **Pronto:** staging separado, atomic swap, backup limitado e nunca apagar fora do managed root.
- **Testes:** kill em cada etapa, disco cheio, downgrade e manifesto revogado.

## P1 — domínio central

### CHR-001 — Formalizar Account/Session/Character/Identity

- **Objetivo:** ownership e IDs estáveis para cada camada.
- **Dependências:** AUTH-002.
- **Arquivos prováveis:** `core/character-state.js`, database schema/migration, web.
- **Referência externa:** SkyrimRoleplay character select; enricomalta character schema.
- **Risco:** alto; migração de dados.
- **Pronto:** invariantes, cardinalidade, lifecycle e owner documentados; migration MariaDB compatível.
- **Testes:** duas contas, múltiplos slots, personagem desativado e sessão trocada.

### CHR-002 — Seleção de slot autoritativa

- **Objetivo:** bind imutável da sessão ao personagem ativo.
- **Dependências:** AUTH-003, CHR-001.
- **Arquivos prováveis:** gamemode auth/character, launcher/panel.
- **Referência externa:** SkyrimRoleplay `characterSelectService.ts`.
- **Risco:** character hopping e race.
- **Pronto:** servidor escolhe a partir de slots permitidos e publica snapshot inicial.
- **Testes:** slot alheio, duplicate select, reconnect, disconnect durante load.

### FAC-001 — Modelo de membership

- **Objetivo:** faction, membership, status e unicidade temporal.
- **Dependências:** CHR-001, transaction primitive.
- **Arquivos prováveis:** novo serviço/repository e migration/schema MariaDB.
- **Referência externa:** SkyrimRoleplay faction whitelist/roster.
- **Risco:** duplicar governance.
- **Pronto:** agregado e boundaries aprovados; sem registrar módulo.
- **Testes:** join duplicado, ban/rejoin, offline member e concorrência.

### FAC-002 — Rank hierarchy e permission resolver

- **Objetivo:** ranks ordenados e capabilities, sem níveis mágicos globais.
- **Dependências:** FAC-001.
- **Arquivos prováveis:** faction domain/core permissions.
- **Referência externa:** SkyrimRoleplay roles; enricomalta PermissionManager.
- **Risco:** privilege escalation/ciclos.
- **Pronto:** deny-by-default, escopo institucional, staff override auditado.
- **Testes:** promote acima do ator, self-promote, cycle, removed rank e override.

### FAC-003 — Repository e audit log

- **Objetivo:** persistência transacional de membership/rank e trilha imutável.
- **Dependências:** FAC-001/002.
- **Arquivos prováveis:** MariaDB repository, `core/moderation-log.js`, schema.
- **Referência externa:** backend roster SkyrimRoleplay; padrão repository enricomalta.
- **Risco:** perda de consistência.
- **Pronto:** transaction, actor/subject/reason/correlation id e schema drift gate.
- **Testes:** rollback, deadlock retry limitado, DB failure e reconnect.

### FAC-004 — Invite/promote/demote flows

- **Objetivo:** commands/intents pequenos sobre o domínio.
- **Dependências:** FAC-003.
- **Arquivos prováveis:** service, UI gateway, commands, panel.
- **Referência externa:** SkyrimRoleplay faction service.
- **Risco:** replay e ação offline.
- **Pronto:** idempotência, autorização e audit; feature flag permanece false até E2E.
- **Testes:** líder promove membro; não autorizado tenta; offline; duplicate packet; persistência.

### PROP-001 — Catálogo de targets físicos

- **Objetivo:** mapear casa/porta/container por IDs e localização permitidos.
- **Dependências:** CHR-001.
- **Arquivos prováveis:** novo property catalog/config/repository.
- **Referência externa:** SkyrimRoleplay housing; DonAthelion ObjectReference API.
- **Risco:** spoof de formId/cell.
- **Pronto:** cliente sugere, servidor resolve e valida distância/célula/tipo.
- **Testes:** target inexistente, outra célula, distância, porta clonada e reload.

### PROP-002 — Ownership e AccessGrant

- **Objetivo:** dono personagem/facção e grants revogáveis (key, tenant, staff).
- **Dependências:** FAC-003, PROP-001.
- **Arquivos prováveis:** property domain/repository e migration.
- **Referência externa:** SkyrimRoleplay properties/keys.
- **Risco:** property stealing/inheritance.
- **Pronto:** transfer/confiscate/revoke atomically, auditado.
- **Testes:** A cria key para B, revoga, B reconnecta e continua sem acesso.

### PROP-003 — Enforcement de lock/container

- **Objetivo:** aplicar grants no uso real, não só na UI.
- **Dependências:** PROP-002.
- **Arquivos prováveis:** SkyMP event handlers, ObjectReference adapter.
- **Referência externa:** SkyrimRoleplay packets; NirnRP/DonAthelion APIs.
- **Risco:** dessincronização A/B/C.
- **Pronto:** resultado autoritativo e revisionado para vizinhos.
- **Testes:** open/lock simultâneo, stale revision, cell transition e disconnect.

### PROP-004 — Suite E2E property

- **Objetivo:** provar ciclo completo antes de habilitar.
- **Dependências:** PROP-003.
- **Arquivos prováveis:** harness E2E e fixtures.
- **Referência externa:** cenários da auditoria.
- **Risco:** flakiness.
- **Pronto:** A claim; B negado; key transfer; revoke; reconnect; confisco; herança.
- **Testes:** matriz acima em 3 clientes e restore de DB.

## P2 — operação e capacidade

### VOI-001 — Spike UDP-helper versus LiveKit

- **Objetivo:** decisão baseada em dados, com um único stack final.
- **Dependências:** nenhuma.
- **Arquivos prováveis:** `voip-service.js`, `voice-helper/`, harness isolado.
- **Referência externa:** theZebco vertical LiveKit.
- **Risco:** alto custo/latência/complexidade nativa.
- **Pronto:** relatório 10/30/50/100 players, NAT, loss, CPU, band, reconnect, mute, cell.
- **Testes:** whisper/normal/shout, move A/B/C, token expiry e server restart.

### OPS-001 — Doctor e supervisor reproduzíveis

- **Objetivo:** validar config/artefato/DB/ports e supervisionar restart com backoff.
- **Dependências:** MOD-001.
- **Arquivos prováveis:** `scripts/phase0/`, operations docs, launcher/server scripts.
- **Referência externa:** F02K buildtool doctor/supervisor.
- **Risco:** restart loop e segredo em log.
- **Pronto:** dry-run, redaction, backoff/jitter, health/readiness e exit codes.
- **Testes:** port ocupado, DB down, config inválida, crash loop e graceful shutdown.

## P3 — pesquisa controlada

- Native APIs para target/raycast/mount devem entrar em spikes separados após PROP-001.
- Save/load Pepsiplaya requer corpus/fuzzing antes de qualquer port.
- NPC host, carroceiro, reloot e survival não entram no MVP sem evidência de valor e orçamento de performance.
- Regional economy, jobs e crafting só avançam depois do protocolo transacional de trade/inventory.

## Gates gerais

Para cada módulo recomendado:

1. unit tests de regras e negações;
2. integration tests com MariaDB real;
3. A/B/C E2E e reconnect;
4. duplicate/replay/race/disconnect;
5. carga em 10/30/50 e pesquisa em 100/200;
6. schema drift e rollback;
7. licença/notices;
8. feature flag false até aprovação explícita.
