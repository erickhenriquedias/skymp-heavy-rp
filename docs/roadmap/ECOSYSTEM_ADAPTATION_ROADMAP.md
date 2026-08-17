# Roadmap de adaptação do ecossistema

Data: **2026-08-13**. Deriva de [`SKYMP_ECOSYSTEM_DEEP_DIVE.md`](../research/SKYMP_ECOSYSTEM_DEEP_DIVE.md) e [`SKYMP_ECOSYSTEM_MATRIX.md`](../research/SKYMP_ECOSYSTEM_MATRIX.md).

## Como este documento se encaixa

Já existem dois planos: [`FORK_RESEARCH_ROADMAP.md`](FORK_RESEARCH_ROADMAP.md) (20 tarefas AUTH/MOD/CHR/FAC/PROP/VOI/OPS da auditoria de 12/08) e a ordem de desbloqueio do [`HEAVY_RP_GAP_ANALYSIS.md`](../research/HEAVY_RP_GAP_ANALYSIS.md).

**Este roadmap não os substitui e não reordena nada deles.** Ele acrescenta as tarefas que a rodada de 13/08 produziu e as encaixa nas fases existentes. Onde uma tarefa nova depende de uma antiga, a dependência está declarada. Se este documento e o `FORK_RESEARCH_ROADMAP` discordarem sobre prioridade, o outro vence — ele nasceu de uma auditoria mais profunda do nosso próprio código.

> **Reconciliado contra `b7c929d` no fim de 13/08/2026.** Este roadmap foi escrito de manhã e, no mesmo dia, três commits (`c442d9b`, `cdf680b`, `326e1be`) entregaram oito das treze tarefas — incluindo `INT-001`, `INT-002` e os dois `CONTRACT`, que ele colocava depois da Fase 0. As seções trazem o estado real e o commit. Uma tarefa nova, `INV-002`, nasceu da reconciliação.

## A regra que governa tudo abaixo

**Nada aqui entra na frente da Fase 0**, e a entrega de 13/08 tornou isso mais verdadeiro, não menos. Ninguém nunca conectou dois clientes, e agora há ~15.700 linhas a mais esperando por essa sessão.

Isso não é formalidade. O maior achado ainda pendente — as APIs de montaria do Hijos — é código C++ que mexe em física do Havok. Portar isso antes de saber se dois jogadores conseguem se ver é a definição de otimização prematura.

---

## P0 — Fase 0: teste real

Inalterado. Ver [`FASE_0_ROTEIRO.md`](../technical/FASE_0_ROTEIRO.md) e [`GUIA_SESSAO_DE_TESTE.md`](../technical/GUIA_SESSAO_DE_TESTE.md).

Esta pesquisa **não adiciona nenhuma tarefa em P0**, de propósito. A única coisa que ela contribui aqui é negativa: nada do que foi encontrado justifica adiar a sessão de teste.

---

## P1 — Core, plataforma e as dívidas que a pesquisa expôs

| ID | Tarefa | Origem | Classe | Estado |
|---|---|---|---|---|
| `SEC-QS-01` | Ticket de fila sai da query string; harness de teste HTTP para `game-api` | achado no **nosso** código | fix | ✅ **feito 13/08** |
| `PATCH-001` | Estrutura `patches/` com manifesto, motivo, commit upstream e condição de perda | Divine Comedy | ADAPT | ✅ **feito 13/08** |
| `MOD-005` | Paridade cobre o que o jogo carrega fora de `Data/` (`Skyrim.ccc`) | Divine Comedy | ADAPT | ✅ **detecção feita 13/08**; decisão de produto aberta |
| `MOD-006` | Gate de load order server-side que recusa boot sem evidência de resolução de FormID | Frostfall | ADAPT | ✅ código em 16/08; runtime SkyMP pendente |
| `RES-001` | Ler a fundo os 5 módulos prioritários do Frostfall | Frostfall | RESEARCH | pendente |
| `RES-002` | Ler a fundo `ModSyncTests` e o RBAC do Crows | Crows | RESEARCH | pendente |

### `SEC-QS-01` — feito em 13/08/2026

Achado durante esta pesquisa, ao verificar se estávamos expostos ao problema que o `SensitiveArgumentMasker.cs` do Crows revela.

**Não estamos expostos pelo caminho deles:** nosso launcher não passa credencial por argumento de linha de comando. O ticket vai para `clientSettings.gameData.launcherTicket` e `config.session`, em arquivo.

**Mas há uma inconsistência no nosso código.** Em `apps/launcher/electron/main.ts`, `join-queue` (linha ~804) manda o ticket no corpo de um POST; `poll-queue` (linha ~820) manda o mesmo ticket na **query string** de um GET. O servidor lê `req.query.ticket` em `apps/game-api/server.js:244`. São 14 linhas de distância tratando o mesmo segredo de dois jeitos.

Severidade honesta: **baixa a moderada**, e menor do que parece.

- O transporte já é `http://` puro, então a query string não acrescenta exposição no fio.
- Os tickets **rotacionam e são de uso único** — `consumeLaunchTicket` gasta, `issuePollTicket` emite o próximo. Um ticket que apareça num log de acesso provavelmente já foi consumido.
- A exposição real é log de servidor e de proxy, onde query string entra e corpo de POST não.

Vale corrigir mesmo assim, por três motivos: é barato, elimina uma inconsistência que convida a erro futuro, e nunca vai custar menos — não há launcher em produção porque a Fase 0 nunca rodou.

**O que foi feito.** A rota virou `POST /api/queue/status` lendo `(req.body || {}).ticket`; `req.query` é ignorado. `poll-queue` passou a usar `postJsonToUrl`, igual ao `join-queue`. `ARCHITECTURE.md` e as três traduções acompanharam o método.

Junto veio `apps/game-api/server.http.test.js`, **o primeiro teste em nível HTTP deste serviço** — a ausência dele é o que deixou o problema passar. Roda sem MariaDB porque `consumeLaunchTicket` recusa ticket ausente ou curto antes de tocar o banco.

Verificado por mutação, como a convenção do projeto exige: revertendo `app.post` para `app.get`, nove testes falham.

**O que continua sem cobertura:** o caminho feliz. Ticket válido, admissão e persistência de sessão exigem banco e seguem sem teste automatizado. Está declarado no rodapé do arquivo de teste.

Registrado como `AUTH-04b` em [`AUTH_001_TRUST_BOUNDARY_INVENTORY.md`](../technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md) — o `AUTH-04` já nomeava a classe "segredo em URL", mas registrava só a ocorrência do `masterKey`, que continua aberta como `AUTH-04a`.

### `PATCH-001` — política de patch antes do primeiro patch

Não temos nenhum patch ao SkyMP hoje, e é justamente por isso que a hora de definir a política é agora. Todo projeto do ecossistema que acabou com um fork pesado começou com um patch sem registro.

Formato, adaptado do Divine Comedy e do que a §4C do briefing pede:

```
patches/
├── README.md         política: quando patch, quando adapter, quando upstream
├── manifest.json     um registro por patch
└── <alvo>/<patch>.patch
```

Cada registro declara: commit upstream de base, motivo, arquivos, impacto, teste que prova que funciona, **condição de perda** (o que faz o patch sumir), estratégia de remoção, e se cabe PR upstream.

A "condição de perda" é a contribuição do Divine Comedy e o campo que ninguém escreve. Eles anotaram que `Skyrim.ccc` volta se o Steam verificar os arquivos e que o patch de `spawn.ts` some num reclone. Um patch cuja perda é silenciosa é pior que patch nenhum.

**Feito em 13/08/2026.** [`patches/`](../../patches/README.md) traz a política com a escada de decisão (SkyMP puro → adapter → PR upstream → patch → fork), o `manifest.json` — **vazio, que é o estado preferido** — e `validate.js`, sem dependências, com 38 testes. A CI roda no job `higiene`, sem `npm ci`.

Além de `loss_condition`, o validador exige justificativa quando `test` ou `upstream_pr` são `null`: patch sem teste e sem explicação é o que a §34 proíbe, e patch que deveria virar PR e nunca vira é um fork começando devagar.

### `MOD-005` — o buraco que o manifesto não vê

Nosso gate de paridade compara o que está em `Data/` contra o manifesto, por hash. `Skyrim.ccc` é lido pelo executável em runtime e **seu conteúdo varia conforme o conteúdo Creation Club que aquela conta Steam possui**. Dois testadores com licenças de CC diferentes carregam listas de plugin diferentes, e o primeiro byte de todo FormID é o índice dessa lista.

Não é bug hoje: `plugins.fase0.txt` exige cinco masters e nada mais, em letras maiúsculas. É armadilha para quando o modpack oficial for montado — e `docs/MODPACK.md` lista cinco plugins de Creation Club como masters obrigatórios, o que faria o modpack **depender de todo jogador ter as mesmas licenças de CC**.

**Detecção feita em 13/08/2026.** `parseCccTxt` e `analyzeCreationClub` em `apps/launcher/electron/parity.mjs`, puros e testáveis como o resto do módulo, ligados ao handler `analyze-plugins`. O `Skyrim.ccc` é lido da raiz do jogo, não de `Data/`.

A checagem é bidirecional, como o resto do módulo:

- CC que o jogador carrega e o servidor não declara → desloca índice;
- CC que o servidor exige e o jogador não carrega → falta record.

Entrada listada no `.ccc` mas sem arquivo em `Data/` **não** é acusada: o jogo não a carrega e nenhum índice se move. Tratá-la como problema reprovaria toda instalação que não comprou tudo.

**A decisão de produto continua aberta**, e detectar não é resolver — quem não tiver o conteúdo simplesmente não entra. As saídas são exigir CC e aceitar barrar quem não tem, ou remover as entradas 6 a 10 do modpack junto com os mods que dependem delas. A segunda parece mais barata. Registrado em [`MODPACK.md`](../MODPACK.md#masters-base).

---

## P2 — Interação e inventário — ✅ entregue em 13/08/2026

| ID | Tarefa | Origem | Classe | Estado |
|---|---|---|---|---|
| `INT-001` | Interaction Registry: alvos, ações, permissão, resolução server-side | Red House + Frostfall | REIMPLEMENT | ✅ `c442d9b` |
| `INT-002` | Módulos registram ações; menu montado no servidor | Red House | REIMPLEMENT | ✅ `c442d9b` |
| `INV-001` | Inventário com donos declarados e razão que fecha | Crows (adapter) | ADAPT | ✅ `cdf680b` — ver ressalva |

**`INT-001`/`INT-002`.** `core/interaction-registry.js`, `interaction-targets.js` e `interaction-service.js`, com [`ADR-002`](../technical/ADR_002_INTERACTION_FRAMEWORK.md). A inversão de dependência era o ponto: a governança fazia `require('./market-stalls-service')` por nome fixo enquanto barracas declaravam `dependencies: ['governance']` — seta nos dois sentidos.

A invariante que este roadmap pedia foi mantida e endurecida: **`canSee` não autoriza nada.** Ele decide um menu montado num instante anterior, na máquina de outra pessoa; `execute` refaz o pipeline inteiro — resolve o alvo, checa permissão e mede distância de novo. Era verdade por acidente do desenho antigo e virou contrato testado.

Só `player` tem resolvedor. Os outros seis tipos falham fechados e nomeados, com `registerResolver` como extensão. **Escrever resolvedores contra APIs `[DOC]` nunca exercitadas seria pior que a ausência, porque pareceria pronto** — é o mesmo critério que esta pesquisa usa para marcar coluna como não verificada.

**`INV-001` foi entregue por outro caminho, e a ressalva importa.** `core/inventory.js` + `core/inventory-owner.js` + migration v14: toda movimentação grava as duas pernas, e para todo `transfer_id` a soma dos `delta` é zero. Isso é mais forte que o adapter do Crows.

Mas **o que o Crows resolve continua aberto**: lá o fake é uma implementação declarada da mesma interface (`adapters/inventory/{protocol,skymp,fake}`), e aqui `mp` segue mockado ad-hoc nos testes. O razão de duas pernas melhora a confiança no servidor; não substitui uma fronteira declarada contra o jogo. Fica como `INV-002`, e continua não dependendo da Fase 0.

**Troca saiu junto**, reescrita como sessão autoritativa com máquina de estados. A regra que a organiza: **confirmação é sobre uma oferta específica, não sobre a sessão** — qualquer mudança incrementa a `version` e derruba as duas confirmações, o que fecha o golpe de trocar a oferta entre a confirmação do outro e a sua. Registrada como módulo `lab` atrás de `ENABLE_TRADE_SERVICE`, que nasce `false`, sem UI CEF.

---

## P3 — Economia e contratos — ✅ entregue em 13/08/2026

| ID | Tarefa | Origem | Classe | Estado |
|---|---|---|---|---|
| `CONTRACT-001` | Máquina de estados de contrato com escrow no post | Mereth | REIMPLEMENT | ✅ `326e1be` — **sete** estados, não oito |
| `CONTRACT-002` | Nota de dívida selada e legível | Mereth | REIMPLEMENT | ✅ `326e1be` |

`core/economy-service.js` (ativo), `contracts-service.js` e `debt-service.js` (ambos PARKED), migration v15, [`ADR-004`](../technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md).

**Este roadmap pedia oito estados e a implementação entregou sete — a implementação estava certa.** Com escrow travado no post, o ouro sai antes de o contrato existir, então `defaulted` não pode acontecer. O Mereth precisa dele porque oferece contratos *unfunded*, em que o cliente paga na entrega; ao adotar só a modalidade funded, o estado morre junto. Copiar os oito teria trazido um estado inalcançável.

As quatro invariantes que este documento listou "como teste desde já" sobreviveram inteiras:

- escrow trava no post — falha na criação produz *sem contrato*;
- **expiração nunca toca trabalho entregue** — virou teste com o nome da regra;
- entrega é contada pelo servidor, item a item;
- inadimplência vira registro, nunca fila de staff. O ADR-004 §4.4 registra que abater automático foi considerado e rejeitado: remove a cena e põe o servidor no papel do agiota.

Ganhou uma quinta que não estava aqui: **`disputed` não decide nada** — o escrow fica travado e resolver é papel de gente.

**A dependência que este roadmap declarava não se materializou como bloqueio.** `ECON-01` exigia economia transacional antes de contratos; o mesmo commit entregou as duas, e o diagnóstico foi mais fundo que o previsto aqui: o problema nunca foi o `transaction-service`, e sim que ele **só sabia falar de patrimônio de um personagem**. Das sete colunas de saldo do projeto, duas nunca receberam uma linha de código.

---

## P4 — Launcher, mod sync e admin

| ID | Tarefa | Origem | Classe | Depende de |
|---|---|---|---|---|
| `RBAC-001` | Elevação de admin separada da autorização comum | Crows | ADAPT | `RES-002` |
| `MOD-007` | Canais stable/beta/development no launcher | Crows | ADAPT | `MOD-001..004` |

`RBAC-001` responde à §21 do briefing. Nosso `admin-service.js` tem permissões, mas não tem elevação explícita — o Crows separa `services/authorization.py` de `services/admin_elevation.py` e audita as duas. A distinção importa: autorização responde "pode?", elevação responde "assumiu o poder agora, e isso ficou registrado".

---

## P5 — Facções, profissões, propriedades

Sem tarefa nova desta rodada. `FAC-001..004` e `PROP-001..004` do `FORK_RESEARCH_ROADMAP` continuam sendo o plano, e a origem continua sendo SkyrimRoleplay.

`RES-001` pode acrescentar aqui: Frostfall tem `factions.js`, `college.js`, `housing.js` e `production.js`, nenhum lido.

---

## P6 — SkyMP e cliente

| ID | Tarefa | Origem | Classe | Depende de |
|---|---|---|---|---|
| `MOUNT-001` | Spike das APIs de par montado do Hijos | Hijos | PORT | P0, `PATCH-001` |
| `MOUNT-002` | Avaliar *lease*/*serial* como padrão geral de estado compartilhado | Hijos | ADAPT | `MOUNT-001` |

`MOUNT-001` é o achado técnico mais forte da pesquisa e está deliberadamente em P6.

O que ele destrava: `horse-service.js` está PARKED com o gate "shared state/ownership não resolvidos — native spike". Esses commits **são** o native spike que o gate pede. `setMountedPairKinematicTransform(horse, rider, lease, serial, …)` e `setCharacterControllerCollisionProfile(actor, profile, lease)` são GPL-3.0, compatíveis com nossa AGPL-3.0, portáveis com atribuição.

Por que não é mais cedo: são ~700 linhas de C++ mexendo em character controller e física do Havok. Fora do `transaction-service`, é o código de maior risco de crash que já consideramos. Exige spike isolado com critério de rollback, e exige `PATCH-001` primeiro — é exatamente o tipo de mudança que vira fork pesado se entrar sem registro.

`MOUNT-002` é a parte que pode valer mais que as montarias. O padrão *lease + serial* — posse temporária revogável, mais número de sequência que descarta atualização fora de ordem — é a mesma coisa que nossa auditoria de 12/08 recomendou de forma independente para estado compartilhado em geral. Duas equipes chegando na mesma peça por caminhos diferentes é o sinal mais forte que uma pesquisa comparativa produz. Vale avaliar como padrão para objetos, portas e containers, não só para cavalos.

---

## P7 — Observabilidade e escala

| ID | Tarefa | Origem | Classe |
|---|---|---|---|
| `OPS-002` | Postgres/Redis nunca publicados; só rede interna | Crows | ADAPT |
| `OPS-003` | Docker Compose com build reproduzível | Crows | RESEARCH |

Os cenários de escala (10/30/50/100/200 jogadores) continuam em [`HEAVY_RP_GAP_ANALYSIS.md`](../research/HEAVY_RP_GAP_ANALYSIS.md#cenários-obrigatórios-de-escala). Esta rodada não os altera.

---

## Rejeitado — e por quê

Registrar rejeição evita que a mesma ideia volte daqui a três meses sem o contexto.

| Item | Origem | Motivo |
|---|---|---|
| Flags CEF de auto-aceite de mídia | Hijos | Removem consentimento e isolamento de origem. Helper WASAPI nativo já resolve melhor |
| Portar launcher C#/WPF | Crows | Nosso launcher é Electron. Portar é reescrever; adaptar ModSync não é |
| Portar backend FastAPI | Crows | Nosso backend é Node. Mesma lógica |
| `sync-client.mjs` | Divine Comedy | Sobrescreve fonte upstream em silêncio, sem registro |
| Papyrus como camada de gameplay | Red House, Frostfall | Roda no cliente: superfície de trust que não precisamos abrir |
| Pesquisar Planet Nirn | Planet Nirn | Sem código próprio. É `skyrim-roleplay/skymp` rebrandado, já pesquisado |
| Esvaziar `Skyrim.ccc` | Divine Comedy | Reverte quando o Steam verifica. `MOD-005` ataca a causa |

---

## Ordem sugerida

Reconciliada contra `b7c929d` no fim do dia 13/08.

```text
Fase 0  ─────────────────────────────────────────►  (bloqueia tudo)
   │
   ├─ ✅ feito 13/08   SEC-QS-01 · PATCH-001 · MOD-005 (detecção)
   │                   INT-001 · INT-002 · INV-001 · CONTRACT-001 · CONTRACT-002
   │
   ├─ não bloqueado    RES-001 · RES-002 · INV-002
   │
   └─ depois da Fase 0
        ✅ MOD-006 → MOD-007
        MOUNT-001 → MOUNT-002        (PATCH-001 já é pré-requisito atendido)
        RES-002 → RBAC-001
```

**Oito das treze tarefas deste roadmap foram feitas no mesmo dia em que ele foi escrito.** Isso diz menos sobre o roadmap e mais sobre o ritmo do projeto — e é a razão de ele carregar a data de reconciliação em vez de fingir que nasceu assim.

Sobram três não bloqueadas: as duas de pesquisa e a `INV-002`, que é o pedaço do `INV-001` que o commit `cdf680b` não cobriu.

O que **não** foi implementado, e por quê:

| Tarefa | Por que não agora |
|---|---|
| `MOUNT-001` | ~700 linhas de C++ em física do Havok. Exige clonar o SkyrimPlatform, compilar e um spike com rollback. Não cabe junto de outras mudanças, e a Fase 0 vem antes |
| `INV-002` | Fronteira declarada contra `mp`, no modelo `adapters/inventory/{protocol,skymp,fake}` do Crows. O razão de duas pernas resolveu o lado do servidor; o lado do jogo continua mockado ad-hoc. Não depende da Fase 0 |
| `RBAC-001` | Depende de `RES-002`: não lemos uma linha do RBAC do Crows, só nomes de arquivo |
| `MOD-007` | Depende da estratégia de canais e de `MOD-001..004`; `MOD-006` já está implementado no código |

## O que a entrega de 13/08 não mudou

Vale registrar porque é o risco de ler este documento e achar que o projeto avançou mais do que avançou.

Interação, inventário, economia, troca, contratos e dívida somam ~15.700 linhas com testes e duas migrations. **Nenhuma linha rodou numa sessão com jogadores.** Os três CHANGELOGs carregam a mesma advertência, e a CEF do menu de interação é hoje a maior superfície não exercitada do projeto: passa em `node --check` e nunca rodou dentro de um CEF.

Contratos e dívida entram PARKED, troca entra atrás de flag que nasce desligada. Isso é a disciplina funcionando, não uma ressalva. Mas significa que **a Fase 0 continua sendo o único item que vale mais que todos os outros somados** — e que ela ficou maior, porque agora há mais superfície a validar do que quando este roadmap foi escrito de manhã.
