# Auditoria de infraestrutura de plataforma

Data: **2026-08-13**. Cobre `apps/launcher`, `apps/game-api` e a parte de `apps/web` que serve o launcher (OAuth exchange, `launch_tickets`, master API de sessões).

Escopo declarado: o caminho **login → whitelist → launcher → update → mod sync → integridade → fila → ticket → sessão → SkyMP**. Não cobre gameplay, banco de dados de personagens nem o bot do Discord.

> **Estado do projeto, que governa toda recomendação abaixo:** ninguém nunca conectou dois clientes. A Fase 0 continua sendo o bloqueio real ([`FASE_0_ROTEIRO.md`](../technical/FASE_0_ROTEIRO.md)). Nenhum item desta auditoria entra na frente dela, e a §17 diz explicitamente o que **não** fazer agora.

> **Atualização de 16/08/2026 — `PLAT-07` corrigido no código:** todo ZIP de
> cliente ou modpack passa agora por inspeção do diretório central antes da
> extração. Caminho absoluto ou com `..`, ADS/nome reservado do Windows,
> colisão case-insensitive, symlink/junction e limites de quantidade/tamanho
> falham antes de qualquer escrita. Os testes incluem um ZIP hostil real. A
> instalação empacotada em máquina limpa continua sendo validação operacional.
>
> **Atualização de 16/08/2026 — `PLAT-27` corrigido no código:** o loader da
> game-api distingue manifesto inválido de `manifest_empty` e recusa tanto
> `mods` vazio quanto `loadOrder` vazia. Assim, `/mods.json` responde `503` no
> servidor em vez de delegar a última barreira ao launcher do jogador.
>
> **Atualização de 16/08/2026 — `PLAT-08` corrigido no código:** feeds,
> downloads e cada destino de redirecionamento exigem HTTPS, porta padrão, URL
> sem credenciais e host exato da allowlist de GitHub Releases. Há limite de
> cinco redirecionamentos e testes para HTTP, host externo, domínio parecido,
> credenciais, porta e redirect hostil.
>
> **Atualização de 16/08/2026 — `PLAT-10` corrigido no código:** a paridade
> deixou de usar `readFileSync` para BSAs. Os arquivos exigidos pelo manifesto
> são hasheados por stream, um por vez, mantendo MD5 apenas por compatibilidade
> com o formato atual. O teste com BSA real acima de 2 GB continua operacional.
>
> **Atualização de 16/08/2026 — `PLAT-06` corrigido no código:** o contrato
> compartilhado exige `manifestVersion: 1`, canal conhecido e identificador de
> build. Gerador, game-api e launcher recusam manifesto legado, versão futura,
> canal desconhecido ou build vazio. Vincular cada URL a um canal específico
> continua sendo o escopo separado de `PLAT-21`.
>
> **Atualização de 16/08/2026 — `PLAT-12` corrigido no código:** o gerador não
> grava mais `sourceDataDir`; o manifesto público preserva apenas a procedência
> lógica da load order, sem caminho absoluto da máquina de build.
>
> **Atualização de 16/08/2026 — `PLAT-17` corrigido no código:** game-api,
> painel web e bot passaram a usar o mesmo rate limiter compartilhado. Ele
> remove buckets expirados por sweep oportunista, impõe teto global de 50.000
> chaves por processo e não acumula requisições que já foram bloqueadas. Não há
> timer permanente nem scan global por requisição. Flood real de IPs distintos
> ainda precisa ser medido em carga.
>
> **Atualização de 16/08/2026 — `PLAT-16` corrigido no código:** a game-api
> remove `launch_tickets` e `game_sessions` vencidos além das retenções
> configuradas, usando `expires_at`, lotes limitados e os índices existentes do
> MariaDB. Roda uma vez no boot e depois oportunisticamente, sem sobreposição e
> sem timer permanente. Backlog e plano real de execução ainda precisam ser
> validados contra uma instância MariaDB.
>
> **Atualização de 16/08/2026 — `PLAT-13` corrigido no código:** antes de abrir
> a porta, a game-api reconstrói a ocupação com sessões ativas do MariaDB. O
> master confirma cada resolução pelo endpoint interno autenticado e falha
> fechado se a fila não reconhecer a admissão. Tokens em claro não são
> reconstruídos. O restart com dois clientes continua sendo teste operacional;
> A migration v19 e o lease por conexão fecharam a revogação ampla; a prova com
> MariaDB e dois clientes reais continua operacional.

---

## 1. Procedência: o que foi verificado, e como

A regra do projeto é marcar de onde vem cada afirmação. Sem isso, uma auditoria cheia parece conhecimento e é chute.

| Fonte | Profundidade | O que isso significa |
|---|---|---|
| `apps/launcher/electron/main.ts` (1225 linhas) | **Completa** — lido inteiro | Achados citam arquivo e linha |
| `apps/launcher/electron/parity.mjs`, `preload.ts` | **Completa** | Idem |
| `apps/launcher/src/pages/Home.tsx`, `Settings.tsx` | **Completa** no fluxo de jogar | Idem |
| `apps/game-api/` (server, queue, modsManifest, gerador, testes) | **Completa** | Idem |
| `apps/web/server.js` | **Parcial** — só master API, OAuth exchange e tickets | O resto do painel não foi auditado aqui |
| `skymp/packages/database/migration-v6`, `v8` | **Completa** | Idem |
| **Crows RP** | **Média** — README do repositório + `docs/MOD_SYNC_ARCHITECTURE.md` + `docs/MOD_SYNC_SECURITY.md` + listagem de `SkyrimRPLauncher.Tests/` | Sobe de "rasa" (matriz de 13/08) para "média". **Nenhum arquivo `.cs` foi lido** — as afirmações são sobre o que a documentação deles declara, não sobre o que o código faz |
| **TESV-RP / Frostfall** | **Rasa** — árvore + `OVH_DEPLOYMENT.md` | Resultado negativo relevante: ver §5.2 |
| **F02K/SkyMP-Launcher** | **Rasa** — README | Achado de licença e de formato relevante para a política de distribuição |

Isso fecha parcialmente a tarefa `RES-002` do [roadmap de adaptação](../roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md): a parte de ModSync foi aprofundada, o RBAC **não**.

---

## 2. O fluxo prometido e o fluxo que existe

O fluxo pedido:

```
Login → Whitelist → Launcher → Update → Mod Sync → Integrity → Queue → Ticket → Session → SkyMP
```

O que `Home.tsx:61-116` realmente executa quando o jogador clica em **JOGAR**:

```
getLauncherConfig → checkGamePath → ensureSkyrimIni(repairOnly)
                 → verifyMods → syncLoadorder → analyzePlugins
                 → joinQueue → [poll a cada 4 s] → launchGame
```

Duas etapas do fluxo desejado **não estão no caminho**:

- **Update** não é chamado. `checkClientUpdate`, `installClientUpdate`, `checkModsUpdate` e `installModsUpdate` existem no `main.ts` e no `preload.ts`, mas o único lugar do renderer que os invoca é a tela de Configurações (`Settings.tsx:95,113,128`). Um jogador que nunca abre Configurações joga com o cliente e o modpack que instalou no primeiro dia.
- **Repair** não existe em lugar nenhum. Não há handler, não há IPC, não há tela.

Havia ainda um terceiro problema descrito pela §21 do briefing: `verify-mods`
parava na primeira divergência. Desde 16/08/2026, a comparação acumula todas as
ausências e corrupções em uma rodada, e a Home mostra um resumo limitado. O
caminho de reparo automático continua ausente e permanece em `PLAT-02`.

**Resumo honesto:** o launcher de hoje é um botão PLAY com uma verificação de paridade boa na frente. A verificação é o melhor pedaço do sistema e o beco sem saída é a consequência direta de ela não ter par — detecta e não conserta.

---

## 3. Achados

Severidade é sobre **o dia em que houver jogadores**, não sobre hoje. Hoje nada disso dói porque não há ninguém conectado.

### 3.1 Fluxo e interface

| ID | Achado | Evidência | Sev. |
|---|---|---|---|
| `PLAT-01` | Update fora do caminho de jogar | `Home.tsx:61-116` vs `Settings.tsx:95` | **Alta** |
| `PLAT-02` | Falha de paridade é beco sem saída: detecta e não conserta | `Home.tsx:84-87` | **Alta** |
| `PLAT-03` | **Corrigido em 16/08/2026:** launcher consulta `/status`, valida o contrato antes do IPC e apresenta todos os estados | `server-status.mjs`, `main.ts`, `Home.tsx` | Resolvida no código |
| `PLAT-04` | Não há máquina de estados: uma string `status` e um booleano `isPlaying` | `Home.tsx:15-16` | Média |
| `PLAT-05` | **Corrigido em 16/08/2026:** `verify-mods` acumula todas as ausências/corrupções e a Home resume sem descartar a contagem | `parity.mjs`, `parity.test.mjs`, `Home.tsx` | Resolvida no código |

`PLAT-03` foi fechado sem entregar a rede ao renderer. O processo principal faz
o GET com timeout e limite de resposta, reduz o JSON ao contrato público e
expõe somente esse resultado pelo IPC. A Home atualiza a cada 15 segundos sem
sobrepor requisições, mostra jogadores/fila e bloqueia JOGAR nos estados
`offline`, `starting` e `maintenance`; `full` oferece entrada na fila. Ainda
falta confirmar visualmente todos os estados no executável empacotado.

### 3.2 Manifesto e sincronização de mods

| ID | Achado | Evidência | Sev. |
|---|---|---|---|
| `PLAT-06` | `mods.json` não era versionado; corrigido em 16/08/2026 com contrato compartilhado v1 | `mods-manifest-contract.js` + gerador/loader/launcher | **Corrigido** |
| `PLAT-07` | Zip slip: extração roda `tar -xf`/`Expand-Archive` direto sobre a pasta do jogo | `main.ts:506-521` | Média-alta |
| `PLAT-08` | Feed/download aceitavam qualquer host; corrigido em 16/08/2026 com allowlist exata e revalidação de redirects | `remote-source-policy.mjs` + `main.ts` | **Corrigido** |
| `PLAT-09` | Substituição não é atômica: sem staging, sem backup, sem quarentena | `main.ts:1127` | Média |
| `PLAT-10` | Paridade carregava o arquivo inteiro; corrigido em 16/08/2026 com hash sequencial por stream | `file-hash.mjs` + `main.ts` | **Corrigido** |
| `PLAT-11` | Arquivo extra em `Data/` passa: `compareMods` só percorre a lista do servidor | `parity.mjs:113-123` | Média |
| `PLAT-12` | `mods.json` publicava o path da máquina geradora; removido em 16/08/2026 | `generate-mods-manifest.js` + teste | **Corrigido** |
| `PLAT-27` | Manifesto vazio era servido com 200; corrigido no loader em 16/08/2026 com `manifest_empty` | `modsManifest.js` + `modsManifest.test.js` | **Corrigido** |

Sobre `PLAT-06`: hoje o launcher não tem como saber se entende o manifesto que recebeu. `isValidManifest` aceita qualquer objeto com `mods[]` e `loadOrder[]`. No dia em que o formato mudar, um launcher antigo lerá o manifesto novo, ignorará os campos que não conhece e **aprovará o jogador com base numa leitura parcial** — que é exatamente a classe de falha que o 503 do `/mods.json` existe pra impedir.

Sobre `PLAT-07`: o hash confere antes de extrair (isso está certo e é explícito em `main.ts:1121-1125`), mas a verificação prova que o ZIP é o ZIP esperado, não que o conteúdo dele é seguro. `tar` e `Expand-Archive` seguem `..` sem reclamar. A defesa hoje é inteiramente "o repositório de distribuição não foi comprometido". Crows trata isso como controle nomeado (`docs/MOD_SYNC_SECURITY.md`: bloqueio de `..`, caminho absoluto, symlink/junction, nome reservado e zip bomb).

Sobre `PLAT-10`: a assimetria foi removida. `verify-mods` calcula MD5 por stream
e mantém somente os hashes pequenos em memória; a validação operacional de uma
BSA real acima de 2 GB continua na lista de testes.

Sobre `PLAT-11`: a direção que falta aqui é a mesma que `analyzePlugins` já corrigiu para plugins (`parity.mjs:199-211`). Para plugins, um extra é reprovado. Para BSA, não — e uma BSA extra pode sobrescrever assets de uma BSA legítima por precedência de carga.

Sobre `PLAT-27`, que apareceu ao escrever a matriz de teste e é o achado mais desconfortável desta auditoria: o cabeçalho de `modsManifest.js` declara, corretamente, que uma lista vazia *"passaria na verificação de paridade e deixaria qualquer modpack entrar, que é exatamente o oposto do que este arquivo existe pra impedir"*. Mas `isValidManifest({ mods: [], loadOrder: [] })` devolve **`true`** — `[].every()` é `true` — e `load()` não faz nenhuma checagem além dessa. O próprio teste registra o buraco sem fechá-lo: `modsManifest.test.js:33` se chama *"aceita manifesto vazio na forma, mas o loader trata o resto"*, e o loader não trata o resto.

O jogador **não** entra, e é importante ser exato sobre por quê: quem barra é `analyzePlugins`, que recusa `serverLoadOrder` vazia (`parity.mjs:165-171`), no **cliente**. Ou seja, a defesa contra o pior modo de falha deste subsistema está num processo que roda na máquina do jogador, enquanto o servidor responde 200 e o comentário no servidor diz que a defesa é dele. Correção: `load()` recusa `mods` ou `loadOrder` vazios, com `reason: 'manifest_empty'`, e o 503 volta a significar o que o documento diz que significa.

### 3.3 Fila, tickets e sessões

| ID | Achado | Evidência | Sev. |
|---|---|---|---|
| `PLAT-13` | **Corrigido em 16/08/2026:** boot reidrata ocupação antes de escutar e o master confirma conexão na fila | `queueRecovery.js`, `queue.js`, `server.js`, `session-occupancy-notifier.js` | Resolvida no código |
| `PLAT-14` | **Corrigido em 16/08/2026:** gamemode reivindica lease opaco e o disconnect revoga/libera somente o hash da conexão exata | `sessionLeaseService.js`, `game-api-session-client.js`, `connection-monitor.js`, migration v19 | Resolvida no código |
| `PLAT-15` | **Corrigido em 16/08/2026:** master consome cada sessão atomicamente uma vez e sessão nova revoga a anterior sob lock da conta | `apps/web/server.js`, `apps/game-api/server.js` | Resolvida no código |
| `PLAT-16` | **Corrigido em 16/08/2026:** tickets e sessões vencidos possuem retenção configurável, limpeza indexada em lotes e limite de trabalho por rodada | `credentialRetention.js`, `credentialRetention.test.js`, `server.js` | Resolvida no código |
| `PLAT-17` | **Corrigido em 16/08/2026:** os três serviços compartilham poda de expirados, teto global e limite de timestamps por bucket | `skymp/packages/sliding-rate-limiter.js`, `apps/game-api/slidingRateLimiter.test.js` | Resolvida no código |

`PLAT-13` permitia que a `game-api` reiniciasse com `_admitted` vazio enquanto
sessões continuavam válidas por até 12 h. Agora o processo consulta o MariaDB e
só abre a porta depois de restaurar contas conectadas e reservas recentes. Se o
estado estiver inválido ou o banco falhar, o boot é recusado. A v19 restaura
também o vínculo da linha e o hash do lease, sem reconstruir credencial em claro.

`PLAT-14` e `PLAT-15` foram fechados juntos porque separar as correções manteria
uma janela de corrida. O master permite somente a transição atômica
`resolve_count: 0 → 1`; o gamemode reivindica um lease distinto antes da
whitelist. Reconectar exige sessão nova, que revoga a anterior sob lock da conta.
Se o disconnect antigo chegar depois, seu hash já não coincide e vira no-op
idempotente. Isso está coberto por testes automatizados, mas ainda precisa dos
cenários operacionais com MariaDB, master e dois clientes reais.

`PLAT-16` tinha número: 40 jogadores em fila por uma hora geram ~36 000 linhas
em `launch_tickets`. Desde 16/08/2026, a game-api preserva uma retenção padrão
de 24 h para tickets e 7 dias após a expiração das sessões, apagando no máximo
10 lotes de 500 linhas por tabela em cada rodada. O teste com backlog real
continua operacional.

### 3.4 Operação

| ID | Achado | Evidência | Sev. |
|---|---|---|---|
| `PLAT-18` | **Corrigido em 16/08/2026:** `/health` é liveness; `/ready` exige manifesto e MariaDB e retorna 503 em falha/manutenção | `readiness.js`, `server.js`, testes HTTP | Resolvida no código |
| `PLAT-19` | **Corrigido em 16/08/2026:** `/health` não expõe fila; `/status` concentra somente estado e contagens públicas agregadas | `server.js`, `server.http.test.js` | Resolvida no código |
| `PLAT-20` | **Corrigido em 16/08/2026:** manutenção vem de env, aparece em `/status` e recusa join/poll antes de consumir ticket | `.env.example`, `server.js` | Resolvida no código |
| `PLAT-21` | Não há canais: `DIST_REPO` único, URLs fixas em `releases/latest/...` e `releases/download/mods/...` | `main.ts:566-572` | Média |
| `PLAT-22` | Nenhuma pinagem reproduzível de versão (`SKYMP_COMMIT`, `HEAVY_RP_VERSION`, `MODPACK_VERSION`) | ausência | Média |
| `PLAT-23` | Nenhuma receita de deploy: sem Dockerfile, sem unit systemd, sem workflow de deploy | `git ls-files` | Baixa hoje |
| `PLAT-24` | Sem rollback | ausência | Baixa hoje |

`PLAT-18/19/20` agora formam três contratos distintos. `/health` prova somente
que o processo responde. `/ready` executa `SELECT 1` no MariaDB, valida o
manifesto e reprova durante manutenção. `/status` é a superfície pública com
enum e contagens agregadas; não inclui ticket, Discord ou detalhes da reserva.
Com `MAINTENANCE_MODE=true`, join e polling são recusados antes de consumir a
credencial. Falta confirmar o comportamento no launcher empacotado e com banco
realmente indisponível.

`PLAT-23` e `PLAT-24` estão marcados como baixos **hoje** de propósito. Ver §17.

### 3.5 Documentação que afirma o que o código não faz

Dois achados de [`docs/MODPACK.md`](../MODPACK.md) §"Notas". Ficam registrados aqui porque são exatamente a classe de problema que o commit `4a57a65` atacou em outro documento, e porque a política de distribuição depende de saber o que o launcher realmente faz.

| ID | Achado | Evidência | Sev. |
|---|---|---|---|
| `PLAT-25` | `MODPACK.md` afirma: *"O launcher move automaticamente para `Data\_disabledByLauncher\` qualquer mod fora da lista"*. **Não existe quarentena no código.** Nenhuma ocorrência de `_disabledByLauncher` em `apps/` | busca no repositório | **Alta** (documental) |
| `PLAT-26` | `MODPACK.md` afirma: *"O launcher detecta e bloqueia GOG e AE não-downgradeados"*. **Metade é verdade.** GOG é detectado (`main.ts:170-174`, via `Galaxy64.dll`/`goggame-*.info`); **build do Skyrim não é verificado em lugar nenhum** — não há leitura de versão do `SkyrimSE.exe` | `main.ts:164-176` | **Alta** (documental) |

Os dois têm o mesmo efeito prático: quem lê a documentação acha que existe uma barreira que não existe, e desenha o modpack contando com ela. `PLAT-26` é o pior dos dois, porque a compatibilidade "exclusivamente com Steam 1.6.1170" é a premissa de todo o resto do documento — e um jogador em AE não-downgradeado passa pelo `validateGamePath` sem nenhum aviso, para descobrir o problema como um crash de SKSE.

A correção de `PLAT-25` é escolher: ou implementar a quarentena (que a §10 desta auditoria já desenha, e que Crows também faz), ou corrigir o documento. A de `PLAT-26` é implementar a leitura de versão do executável — é barata e é justamente o tipo de checagem que a §4 do briefing quer no estado `CHECKING_MODPACK`.

---

## 4. O que já está certo

Vale registrar, porque uma auditoria que só lista defeito distorce a decisão de onde mexer.

- **Hash ausente aborta.** Tanto no cliente (`main.ts:1034-1037`) quanto por parte do modpack (`main.ts:1116-1119`). Um manifesto sem `sha256` faz o download falhar em vez de instalar sem verificar. Manifesto malformado é indistinguível de comprometido, e o código trata os dois igual.
- **Hash confere antes de extrair**, nunca depois (`main.ts:1121-1128`).
- **`/mods.json` responde 503 e nunca lista vazia** (`server.js:193-202`). Lista vazia passaria na verificação e deixaria qualquer modpack entrar.
- **Paridade bidirecional de load order**, incluindo Creation Club fora do `plugins.txt` (`parity.mjs:199-211`, `275-319`). É o pedaço mais rigoroso do sistema e não tem equivalente visível no ecossistema.
- **Ticket de uso único com rotação** e consumo atômico por `UPDATE` condicional (`server.js:153-167`). A propriedade de uso único sob concorrência está correta.
- **Só hash em repouso** para `launch_tickets` e `game_sessions`. Vazamento de banco não vira credencial.
- **Client secret do Discord fora do instalador** (`apps/web/server.js:758-822`), com allowlist de `redirect_uri`.
- **Janela de OAuth sem preload** (`main.ts:726-732`) e navegação travada na janela principal (`main.ts:84-103`). O endurecimento de IPC do Electron está feito.

---

## 5. Referências externas: classificação

Classes conforme o briefing: `ADAPT` (trazer a ideia e a forma), `REIMPLEMENT` (trazer só o conceito, escrever do zero), `IGNORE`.

> **Barreira de licença.** Crows RP **não tem licença** — todos os direitos reservados, conforme já registrado na [matriz do ecossistema](SKYMP_ECOSYSTEM_MATRIX.md). Nada de lá pode ser copiado. Tudo abaixo é conceito, e a origem fica registrada. F02K/SkyMP-Launcher é **MIT**, então dele *seria* possível reusar código com atribuição — mas é Electron/TypeScript como o nosso, o que torna a opção real e não teórica.

### 5.1 Crows RP (`LucasMagnoSP/Crows-RP`)

| Item | Classe | Motivo |
|---|---|---|
| Três canais de update independentes (`stable`/`beta`/`development`), com canal de mod separável do canal do app | **ADAPT** | Resolve `PLAT-21` e é a única forma de testar uma atualização antes de ela chegar em todo mundo. Ver §9 |
| Staging → backup → live com rollback e quarentena | **ADAPT** | Resolve `PLAT-09`. O padrão é independente de linguagem |
| Controles anti-zip-slip nomeados (`..`, caminho absoluto, symlink, nome reservado, zip bomb) | **ADAPT** | Resolve `PLAT-07`. É uma lista de verificação, não código |
| Allowlist de host do feed, com rejeição de redirecionamento pra host não autorizado | **ADAPT** | Resolve `PLAT-08` |
| SHA-256 obrigatório do ZIP **e de cada arquivo imutável** | **ADAPT** | Nós temos o primeiro, não o segundo. É o que habilita repair granular (§10) |
| `/health` e `/ready` separados | **ADAPT** | Resolve `PLAT-18` |
| `deploy/versions.env` com `SKYMP_COMMIT` e `SKYMP_BUILD_VERSION` | **ADAPT** | Resolve `PLAT-22` **e é barato hoje** — é um arquivo |
| Suíte de testes como especificação (`ModSyncTests`, `UpdateChannelTests`, `VersionCompareTests`) | **ADAPT** (como matriz, não como código) | Vira [`LAUNCHER_PLATFORM_TEST_MATRIX.md`](../testing/LAUNCHER_PLATFORM_TEST_MATRIX.md) |
| Ed25519 preparado e **não ativo** para assinar o manifesto | **REIMPLEMENT**, depois | Interessante e prematuro: assinar manifesto antes de existir modpack é cerimônia |
| Validação de DLL de plugin (x64, editor em allowlist, formato PE) sem executar | **REIMPLEMENT** | Boa ideia, escopo próprio, depende de existir modpack com DLL |
| Velopack | **IGNORE** | É o atualizador do .NET. Nosso launcher é Electron; o equivalente é `electron-updater`, e **nem esse cabe agora** (§9) |
| Launcher C#/WPF, backend Python/FastAPI, hexagonal | **IGNORE** | Portar é reescrever. Já era a conclusão da matriz de 13/08 e nada aqui a contradiz |
| Postgres/Redis só na rede Docker | **ADAPT** como princípio | Já é o que fazemos por firewall; registrar como regra explícita em `OPERATIONS.md` §5 |
| RBAC + elevação de admin + audit | **não avaliado aqui** | `RES-002` continua **parcialmente aberto** — nada de RBAC foi lido nesta rodada |

### 5.2 TESV-RP / Frostfall (`qalamabdulkhaliq/TESV-RP`)

**Resultado negativo, e ele economiza trabalho.** O repositório tem `Frostfall-Backend` e `Frostfall-Server` — **não tem launcher**. O `OVH_DEPLOYMENT.md` descreve Node instalado à mão, `npm ci`, `server-settings.json` a partir de um exemplo e "veja aparecer esta linha no log" como verificação de saúde. Sem gerenciador de processo, sem porta declarada, sem rollback.

Classe: **`IGNORE`** para tudo que se refere a launcher e deploy. O briefing pedia "estudar Crows/Frostfall" para produção; a verificação mostra que Frostfall **não é referência de produção**. A única coisa aproveitável já estava registrada: o `loadOrderGate` server-side, que é a tarefa `MOD-006` do roadmap e não pertence a esta auditoria.

### 5.3 F02K/SkyMP-Launcher

MIT, Electron/TypeScript, e com uma decisão de formato que é diretamente relevante à §9 do briefing: **o manifesto assinado deles nomeia um slug de Nexus Collection, revisão fixada, lista de plugins, load order e hashes — e exclui deliberadamente os arquivos**. A distribuição do conteúdo fica com o Nexus e com o Vortex, em sandbox; o launcher só verifica e faz hardlink a partir de um cache imutável por hash.

| Item | Classe | Motivo |
|---|---|---|
| Manifesto que carrega hash e ordem mas **não** carrega arquivo | **ADAPT** | É a resposta estrutural ao problema de redistribuição (§9). Ver [`MOD_DISTRIBUTION_POLICY.md`](../platform/MOD_DISTRIBUTION_POLICY.md) |
| Cache imutável indexado por hash + hardlink com fallback pra cópia | **ADAPT**, depois | Bom para repair e para múltiplos perfis; caro agora |
| Integração Vortex/Collections como instalador | **IGNORE** | Já decidido e registrado em [`LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) §5: Collection instalada "corretamente" em duas máquinas pode produzir load orders diferentes. **A decisão de não migrar continua de pé** — o que este achado muda é só a §9, sobre *distribuir bytes*, não sobre *resolver load order* |
| Directory auto-hospedado com Ed25519 e fingerprint SHA-256 fixável | **IGNORE** para nós | Resolve "descobrir servidores"; nós temos um servidor só |

---

## 6. Desenho: máquina de estados do launcher

Resolve `PLAT-04` e é pré-requisito de `PLAT-01` e `PLAT-02` — sem estados nomeados não há onde encaixar update nem repair.

```
                  ┌──────────┐
                  │ STARTING │
                  └────┬─────┘
                       ↓
              ┌─────────────────┐
              │ CHECKING_UPDATE │───falha rede──┐
              └────┬────────────┘               │
                   ↓                            │
             ┌───────────┐                      │
             │ UPDATING  │──falha hash/extração─┤
             └────┬──────┘                      │
                  ↓                             │
          ┌────────────────┐                    │
          │ AUTHENTICATING │──recusa/timeout────┤
          └────┬───────────┘                    │
               ↓                                │
       ┌───────────────────┐                    │
       │ CHECKING_MODPACK  │                    │
       └──┬──────────────┬─┘                    │
          │ ok           │ divergência          │
          ↓              ↓                      │
      ┌───────┐     ┌──────────┐                │
      │ READY │     │ REPAIRING│──irreparável───┤
      └──┬────┘←────└──────────┘                │
         ↓                                      │
    ┌────────┐                                  │
    │ QUEUED │──────────────┐                   │
    └───┬────┘              │                   │
        ↓                   │                   │
 ┌──────────────────┐       │                   │
 │ REQUESTING_TICKET│───────┤                   │
 └───┬──────────────┘       │                   │
     ↓                      ↓                   ↓
┌───────────┐          ┌────────────────────────────┐
│ LAUNCHING │          │           ERROR            │
└───────────┘          │ (código + ação + retry?)   │
                       └────────────────────────────┘
```

Regras que fazem a diferença entre isto e o `status: string` de hoje:

1. **`ERROR` nunca é terminal sem ação.** Todo estado de erro carrega três coisas: um código estável (`MODPACK_HASH_MISMATCH`, `BACKEND_UNREACHABLE`, `TICKET_EXPIRED`), uma frase para o jogador, e **qual botão aparece** — `Tentar de novo`, `Reparar`, `Abrir Configurações` ou `Copiar diagnóstico`. `PLAT-02` existe porque hoje esse terceiro campo não existe.
2. **`CHECKING_MODPACK` tem duas saídas, não uma.** A saída "divergência" vai para `REPAIRING`, não para `ERROR`. Essa aresta é a correção de `PLAT-02`.
3. **`QUEUED` é o único estado com polling.** Hoje o `setInterval` de `Home.tsx:32` roda mesmo enquanto o jogo está subindo; com estados, ele para ao sair de `QUEUED`.
4. **Nenhum estado é "carregando".** Cada um tem nome, e o nome vai para a tela. A §4 do briefing pede exatamente isso, e a razão prática é diagnóstico: "travou em `CHECKING_MODPACK`" é reportável; "travou carregando" não é.
5. **`REQUESTING_TICKET` é separado de `LAUNCHING`** porque o ticket expira. Um ticket obtido e não usado em segundos é a falha da §14, e ela precisa de um estado próprio para ser observável.

---

## 7. Desenho: manifesto de modpack v2

Resolve `PLAT-06`, `PLAT-11` e `PLAT-12`. Formato proposto:

```jsonc
{
  "manifestVersion": 2,          // inteiro; launcher que não conhece RECUSA, não ignora
  "channel": "stable",           // stable | beta | development
  "build": "2026.08.13+1",       // identidade do conjunto; é o que o servidor exige na conexão
  "generatedAt": "2026-08-13T20:00:00.000Z",
  "loadOrder": ["Skyrim.esm", "Update.esm", "..."],
  "extraFilePolicy": "reject",   // reject | warn | ignore — ver §11
  "files": [
    {
      "path": "Data/HeavyRP.esm",   // relativo à raiz do jogo, SEMPRE com barra normal
      "size": 12345678,
      "sha256": "…",
      "downloadUrl": "https://…",   // ausente = não redistribuível; ver política
      "required": true,
      "category": "plugin"          // plugin | archive | script | binary | config
    }
  ]
}
```

Diferenças que não são cosméticas:

- **`manifestVersion` é uma recusa, não um aviso.** Launcher que lê um `manifestVersion` maior que o que conhece entra em `ERROR` com código `MANIFEST_TOO_NEW` e a ação "atualizar o launcher". A alternativa — ignorar campos desconhecidos — é a que produz aprovação com base em leitura parcial.
- **`build` é o identificador que vai para o servidor.** Hoje a paridade é verificada só no cliente, e um launcher modificado pula a verificação inteira. Com `build`, o gate server-side de `MOD-006` tem o que exigir. Esta auditoria **não** implementa esse gate; só garante que o manifesto carregue o dado que ele vai precisar.
- **`path` substitui `filename`.** O formato atual só nomeia arquivos soltos em `Data/`; conteúdo de modpack vive em subpastas (`Data/SKSE/Plugins/…`, `Data/Scripts/…`). Regra de validação obrigatória, e ela é a defesa de `PLAT-07` no nível do formato:

  > `path` deve ser relativo, usar `/` como separador, e **não pode** conter `..`, começar com `/`, conter `:` (drive do Windows / ADS) nem casar com nome reservado do Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`). O launcher rejeita o manifesto inteiro se **qualquer** entrada violar — não a entrada, o manifesto. Um manifesto com uma entrada maliciosa não é um manifesto parcialmente bom.

- **`sha256` por arquivo, e não só do ZIP.** É o que habilita repair granular (§10). Continuamos aceitando MD5? **Não.** A justificativa de MD5 em `generate-mods-manifest.js:11-19` (velocidade, e o hash não é barreira criptográfica) é válida *hoje*, mas o v2 hasheia arquivo por arquivo justamente para permitir baixar só o que quebrou — e nesse ponto o hash passa a decidir qual byte substitui qual byte. Um SHA-256 por stream custa ~2× um MD5 por stream e elimina a discussão. **A migração de MD5 para SHA-256 é uma quebra de compatibilidade e por isso é `manifestVersion: 2`.**
- **`downloadUrl` opcional** é o que codifica a política de redistribuição. Ausente significa "este arquivo é verificado mas não distribuído por nós"; o launcher precisa então de instruções, não de um download. Detalhe em [`MOD_DISTRIBUTION_POLICY.md`](../platform/MOD_DISTRIBUTION_POLICY.md).
- **`extraFilePolicy` torna explícito o que hoje é acidental.** Ver §11.

### Compatibilidade

O v1 (`{ mods: [{filename, hash}], loadOrder }`) continua sendo servido enquanto houver launcher v1 em campo — o que hoje é zero, porque nunca houve distribuição. **A janela de fazer essa migração sem custo é agora**, e ela fecha no dia em que o primeiro jogador instalar o launcher.

---

## 8. Canais

`PLAT-21`. Proposta:

| Canal | Quem recebe | Regra |
|---|---|---|
| `stable` | jogadores | Só recebe o que passou por `beta` numa sessão real |
| `beta` | testadores declarados | Onde a Fase 0 acontece |
| `development` | quem desenvolve | Pode quebrar; ninguém mais aponta pra cá |

**Canal do launcher e canal do modpack são separados**, com o do modpack herdando o do launcher por padrão (é o que Crows faz, e a razão é concreta): dá para testar um modpack novo com o launcher estável, e testar um launcher novo com o modpack de produção. Sem essa separação, toda mudança de modpack exige uma versão de launcher, e o inverso também.

Implicação de formato: o `channel` está no manifesto (§7) **e** a URL do feed muda por canal. As duas coisas — a URL diz onde buscar, o campo diz o que se recebeu, e o launcher recusa quando divergem. Um manifesto de `development` servido na URL de `stable` é um erro de publicação, e é exatamente o tipo de erro que o campo pega.

---

## 9. Mod sync

O fluxo pedido pela §7 do briefing, com o que já existe marcado:

| Passo | Hoje | Falta |
|---|---|---|
| buscar manifesto | ✅ `httpGetJson` | allowlist de host (`PLAT-08`) |
| comparar com local | ⚠️ por carimbo de versão inteiro (`skymp_mods_version.txt`) | comparação por arquivo |
| hashear os obrigatórios | ⚠️ só em `verify-mods`, com MD5 e sem stream | stream + SHA-256 (`PLAT-10`) |
| baixar as diferenças | ⚠️ por *parte* de ZIP (`contentSig`), não por arquivo | granularidade de arquivo |
| arquivo temporário | ✅ `app.getPath('temp')` | — |
| verificar hash | ✅ antes de extrair, e ausência aborta | hash por arquivo extraído |
| substituição atômica | ❌ extrai direto sobre a pasta do jogo | staging → backup → live (`PLAT-09`) |
| validação final | ❌ | re-hash do que foi escrito |

**O que não muda:** nunca substituir antes de validar. Isso já está certo e não deve regredir na reescrita — é a linha `main.ts:1121-1125`.

**O que a granularidade por parte não resolve:** hoje, se um único arquivo corromper, a menor unidade de conserto é uma parte inteira do ZIP. Com hash por arquivo, a unidade é o arquivo. É a diferença entre um repair de 40 MB e um de 8 GB, e é a razão pela qual `PLAT-09` e o `sha256` por arquivo da §7 andam juntos.

---

## 10. Repair

Não existe (`PLAT-02`). Desenho:

**Detecta quatro classes:**

| Classe | Como | Ação |
|---|---|---|
| ausente | `path` do manifesto não existe no disco | baixar |
| corrompido | existe, `sha256` não confere | baixar por cima (via staging) |
| versão errada | carimbo local ≠ `build` do manifesto | sincronização normal, não repair |
| extra inesperado | arquivo em `Data/` que o manifesto não conhece | depende de `extraFilePolicy` (§11) |

**Regras:**

1. Repair **nunca apaga** — move para quarentena. É o que Crows faz e a razão é diagnóstico: um arquivo apagado não conta o que aconteceu. Quarentena com data e motivo conta.
2. Repair é **incremental por padrão** e tem um modo `--full` explícito. O `force` de hoje (`install-mods-update`, `main.ts:1074`) já é o modo full; falta o incremental.
3. Repair **não roda sozinho antes de perguntar** quando implica baixar mais que um limiar (proposta: 500 MB). Um jogador com internet limitada precisa saber antes, não depois.
4. O relatório de repair lista **todos** os arquivos, não o primeiro — a correção de `PLAT-05` no nível de dados.

---

## 11. Política de arquivo extra

`PLAT-11` e `PLAT-12`. Hoje o comportamento é inconsistente por acidente: plugin extra reprova (`parity.mjs:204-211`), arquivo extra não é sequer olhado.

Proposta — o manifesto declara, o launcher obedece:

| `extraFilePolicy` | Comportamento | Quando |
|---|---|---|
| `reject` | Qualquer arquivo em `Data/` fora do manifesto reprova | Modpack fechado, produção |
| `warn` | Reporta, não bloqueia | Fase 0 e teste, onde os testadores têm instalação própria |
| `ignore` | Só verifica o que o manifesto lista | Desenvolvimento |

**Plugins continuam sendo caso à parte, sempre `reject`**, independente da política — porque plugin extra desloca índice de load order e portanto quebra o contrato de FormID, o que nenhuma política de conveniência pode relaxar. Textura extra não desloca nada. A distinção já está implícita no gerador (`generate-mods-manifest.js:29-34`, que só hasheia plugins e BSAs); a política a torna explícita.

Isto **é uma decisão de produto pendente**, ligada ao `MOD-005` do roadmap ("decisão de produto aberta"). Esta auditoria propõe o mecanismo, não escolhe o valor padrão para produção.

---

## 12. Responsabilidades da `game-api`

A §10 do briefing pede a fronteira. Ela hoje está certa e vale registrar antes que se perca:

**Pode:** autenticação por ticket, elegibilidade/whitelist, fila, emissão de ticket de sessão, persistência de sessão, manifesto de mods, status do servidor.

**Não deve:** nada de gameplay. Nenhum estado de personagem, nenhum inventário, nenhuma economia. Esses vivem no gamemode, contra o banco, e a `game-api` não os enxerga — o que hoje é verdade e se prova pela lista de tabelas que ela toca: `launch_tickets`, `game_sessions`, `accounts`, `whitelist_applications`, `characters` (só `COUNT`).

A regra operacional: **a `game-api` decide quem entra; o gamemode decide o que acontece depois.** Um endpoint novo que precise saber o que o jogador tem no inventário está do lado errado da linha.

---

## 13. `/health` e `/ready`

`PLAT-18`, `PLAT-19`. Implementados como três endpoints com públicos diferentes:

| Endpoint | Público | Responde | Conteúdo |
|---|---|---|---|
| `GET /health` | orquestrador | 200 sempre que o processo responde | `{ ok: true }` |
| `GET /ready` | orquestrador | 200 só com **manifesto carregado E banco respondendo**, fora de manutenção | `{ ready, checks: { manifest, database, maintenance } }` |
| `GET /status` | launcher, público | 200 | `{ state, players, capacity, queue, message }` |

Por que três e não dois: `/health` e `/ready` respondem a perguntas operacionais
distintas; `/status` responde ao que pode ser mostrado ao jogador e é público
por natureza. A separação já existe no código.

**`/status` não expõe métrica sensível** (§12 do briefing): nada de IP, nada de `discordId`, nada de nome de conta, nada de estado interno da reserva. `players` e `queue` são contagens. `state` é um enum: `online`, `maintenance`, `starting`, `full`.

`PLAT-20` usa `MAINTENANCE_MODE` e `MAINTENANCE_MESSAGE`. O caminho de manutenção
não consulta banco para responder `/status` e barra a fila antes da validação do
ticket.

---

## 14. Fila: o que testar

A §13 do briefing lista seis cenários. Estado de cobertura em `queue.test.js` (13 testes em 6 suítes, todos em memória — verificado com `node --test`):

| Cenário | Coberto | Observação |
|---|---|---|
| fila duplicada | ✅ | `join` repetido é idempotente por conta |
| múltiplas instâncias do launcher | ❌ | Não é um caso da fila, é um caso do **ticket**: dois launchers com o mesmo `auth.json` disputam o mesmo `launchTicket` de uso único. Um ganha, o outro recebe `invalid_ticket` e não sabe por quê |
| reserva expirada | ✅ | TTL de 3 min; quem conectou não perde por tempo |
| desconexão | ✅ | `release` promove o próximo |
| corrida de capacidade | ✅ código | A fila é síncrona; no restart, a porta agora só abre após reidratar a ocupação do MariaDB (`PLAT-13`). Falta o cenário operacional com dois clientes |
| expiração de ticket | ⚠️ | Coberto no nível HTTP só pela recusa (`server.http.test.js`); o caminho feliz exige banco e segue sem teste |

A conclusão que interessa: **a fila, o replay e a revogação exata estão cobertos
estaticamente; o que falta está nas integrações reais.** Permanecem os cenários
com MariaDB e clientes reais, inclusive reconnect e disconnect atrasado. Detalhamento em
[`LAUNCHER_PLATFORM_TEST_MATRIX.md`](../testing/LAUNCHER_PLATFORM_TEST_MATRIX.md).

---

## 15. Tickets e sessões

Os quatro requisitos da §14 do briefing, conferidos contra o código:

| Requisito | Estado |
|---|---|
| curta duração | ✅ 5 min (`apps/web/server.js:727`), 300 s no poll (`game-api/server.js:286`) |
| propósito único | ✅ `UPDATE` condicional com `affectedRows === 1` |
| opaco | ✅ 32 bytes de `crypto.randomBytes`, hash em repouso |
| emitido pelo servidor | ✅ só o painel emite o inicial; só a `game-api` emite os de poll |

Nada a corrigir aqui. **O problema está uma camada adiante**, em `game_sessions` (§3.3):

- `PLAT-14` — resolvido por lease opaco: o banco guarda apenas SHA-256, e o `release` atualiza a linha que possui aquele hash exato.
- `PLAT-15` — resolvido por sessão de master de uso único. Crash/reconnect volta ao launcher para obter uma sessão nova; a emissão nova revoga a anterior. Isso troca conveniência de reutilizar uma credencial de 12 h por uma fronteira verificável e sem heurística de IP.

---

## 16. Segurança: inventário desta auditoria

Para incorporação ao [`AUTH_001_TRUST_BOUNDARY_INVENTORY.md`](../technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md).

| ID | Item | Estado |
|---|---|---|
| OAuth | Client secret fora do instalador, `redirect_uri` em allowlist, `state` verificado | ✅ correto |
| Tokens do launcher | Uso único, rotação, hash em repouso | ✅ correto |
| IPC do Electron | `contextIsolation` ligado, `nodeIntegration` desligado, janela de OAuth sem preload, `will-navigate` e `setWindowOpenHandler` travados | ✅ correto |
| URL remota | HTTPS, porta padrão e host exato da allowlist | ✅ `PLAT-08` corrigido em 16/08/2026 |
| Feed de update | Mesma política, reaplicada a cada redirect, com limite de cinco saltos | ✅ `PLAT-08` corrigido em 16/08/2026 |
| Path traversal (manifesto) | `compareMods` casa contra arquivos locais listados, então não há travessia por aí | ✅ hoje; o v2 com `path` **precisa** da validação da §7 |
| Zip slip | Preflight do diretório central antes da extração, com teste de ZIP hostil real | ✅ `PLAT-07` corrigido em 16/08/2026 |
| Bypass de checksum | Hash ausente aborta, hash confere antes de extrair | ✅ correto |
| Replay de sessão | Consumo atômico único no master; sessão nova revoga a anterior | ✅ código, falta integração real `PLAT-15` |
| API em localhost | Callback de OAuth em `127.0.0.1:19847`, só durante o login, com `state` | ✅ correto |
| Segredos | `INTERNAL_API_SECRET` obrigatório via `requireEnv`, comparação em tempo constante; CI recusa `.env` versionado | ✅ correto |
| Credencial em linha de comando | Não fazemos (`SEC-ARG-01` já verificado em 13/08) | ✅ não estamos expostos |

---

## 17. Deploy, pinagem e rollback — e por que quase nada disto agora

A §16 do briefing diz: *"Não migrar infraestrutura apenas por estética."* Esta é a seção que leva isso a sério.

**O que fazer agora, porque é barato e ajuda a Fase 0:**

- **`PLAT-27` fechado em 16/08/2026** — o loader agora recusa manifesto vazio
  antes de `/mods.json` responder.
- **`deploy/versions.env`** com `SKYMP_COMMIT`, `HEAVY_RP_VERSION` e `MODPACK_VERSION`. É um arquivo de texto. Resolve `PLAT-22` e responde a pergunta que a Fase 0 vai fazer no primeiro problema: *"qual build era?"*. Sem isso, um bug reproduzido é um bug irreprodutível.
- **`/ready`** (`PLAT-18`) — implementado com MariaDB, manifesto e manutenção.
- **`/status`** (`PLAT-03`, `PLAT-19`, `PLAT-20`) — backend e consumo no
  launcher implementados; falta validar visualmente todos os estados no
  executável empacotado.

**O que não fazer agora:**

- **Docker.** Crows usa e faz sentido para eles: têm jogadores, têm runner self-hosted, têm Postgres e Redis para isolar. Nós temos uma máquina Windows, um MySQL, e zero sessões realizadas. Containerizar antes da Fase 0 acrescenta uma camada entre o desenvolvedor e o erro que ele está tentando reproduzir, e o erro que estamos tentando reproduzir é "dois clientes não se veem".
- **systemd.** É Linux; o ambiente atual é Windows com `Start-AllServices.ps1`. A migração é uma decisão de hospedagem, não de código.
- **Workflow de deploy.** Deploy automatizado para um servidor que ninguém acessa é cerimônia.
- **Rollback automático.** E aqui vale a advertência da §18 do briefing, que está certa: **nunca prometer rollback automático de migration irreversível.** Nossas migrations são `CREATE TABLE IF NOT EXISTS` e `ALTER`; um `ALTER` que remove coluna não volta sozinho. O que dá pra prometer honestamente é: *o código volta; o banco volta só se a migration daquela versão for reversível, e o registro precisa dizer quais são.*

**Ordem restante quando chegar a hora**: pinagem → canais → staging/backup na
instalação → só então empacotamento e deploy automatizado.

---

## 18. O que esta auditoria não faz

- **Não implementa nada.** Todos os achados estão descritos com arquivo e linha; nenhuma linha de código foi alterada.
- **Não fecha `RES-002`.** O RBAC do Crows continua sem leitura. Só a metade de ModSync foi feita.
- **Não decide o `extraFilePolicy` de produção** (§11) — é decisão de produto, ligada ao `MOD-005`.
- **Não decide o certificado de assinatura.** Continua em [`LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) §6.3, e continua sendo uma compra.
- **Não leu nenhum arquivo `.cs` do Crows.** As afirmações sobre eles são sobre a documentação que publicam. Onde este documento diz "Crows faz X", leia "a documentação do Crows declara X".
- **Não valida nada em sessão real.** Como todo o resto do repositório: nada disto rodou com jogadores, porque nunca houve jogadores.

---

## 19. Documentos irmãos

- [`docs/platform/MOD_DISTRIBUTION_POLICY.md`](../platform/MOD_DISTRIBUTION_POLICY.md) — o que pode e o que não pode ser redistribuído, e como o manifesto codifica isso.
- [`docs/testing/LAUNCHER_PLATFORM_TEST_MATRIX.md`](../testing/LAUNCHER_PLATFORM_TEST_MATRIX.md) — os cenários da §20 do briefing, com o que é automatizável e o que não é.
- [`docs/technical/LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) — o que o código faz **hoje**. Onde os dois divergirem, aquele descreve o presente e este propõe o futuro.
