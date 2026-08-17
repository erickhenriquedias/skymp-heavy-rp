# Matriz de compatibilidade e procedimento de atualização

Data: **2026-08-14**. Responde ao briefing §17, §18 e §19.

**Este documento é a única declaração de versão do projeto.** Se outro documento afirmar uma versão de SkyMP, Skyrim ou SkyrimPlatform, ele está copiando daqui — ou está errado.

---

## 1. A matriz

| Campo | Valor | Como foi obtido |
|---|---|---|
| **Heavy RP** | `v0.1.0` + 119 commits (`a27a173`, 13/08/2026) | `git describe --tags` |
| **SkyMP (pin)** | `d85f18d808f877401c4e20484d2c2f6f73cf9caa` — main, 06/08/2026 | `patches/manifest.json`, campo `upstream.pin` |
| **SkyMP servidor** | AGPL-3.0 | `skymp5-server/LICENSE` |
| **SkyMP cliente / front / SkyrimPlatform** | GPL-3.0 | LICENSE de cada subprojeto |
| **`libespm`, `papyrus-vm`, `skymp5-functions-lib`** | MIT | idem |
| **Skyrim** | Special Edition **1.6.1170** (Steam) | `docs/MODPACK.md` |
| **SKSE64** | build correspondente a 1.6.1170 | `SKYMP_SERVER_SETUP.md` |
| **SkyrimPlatform** | **2.9.0** é a última release documentada; suporte a 1.6.1170.0 entrou nela | `docs/release/sp-2.9.md` do upstream |
| **Modpack** | Ver `docs/MODPACK.md`; decisão de Creation Club **aberta** (`LOP-004`) | — |
| **Cliente Heavy RP** | `MIN_VERSION = "1.0.0-beta"` em `version-check.js`; launcher em `0.0.0` | leitura de código |

### O que esta tabela mostra que não é confortável

**A versão do cliente é declarada em dois lugares que não se falam.** `version-check.js` exige `"1.0.0-beta"`; `apps/launcher/package.json` diz `0.0.0`. Nenhum jogador passaria pela checagem hoje — e o caminho de recusa dela chama `admin.kickPlayer(0, actorId, …)`, que é justamente a chamada com `actorId` no lugar de `userId` do achado nº 3 da [auditoria de fronteira](../research/SKYMP_INTEGRATION_AUDIT.md) §6.

**Não existe registro de qual build de servidor está em `skymp/server/`.** O binário está no repositório, o commit de origem não. É o gatilho de `COMPAT-001`.

**GOG e versões Steam diferentes de 1.6.1170.0 são recusadas pelo launcher**
antes de save, update, repair, rollback ou JOGAR. A decisão possui teste
unitário; a leitura real do `FileVersion` no executável empacotado ainda precisa
ser exercitada em instalações reais.

---

## 2. Como saber em que commit o servidor que rodamos foi construído

Hoje, não dá. É a lacuna mais barata de fechar deste documento.

`COMPAT-001`: gravar o commit do SkyMP no artefato de build e expô-lo. Duas saídas, e a segunda é melhor:

1. Um arquivo `skymp/server/BUILD_INFO.json` gerado no build, com commit, data e triplet.
2. O gamemode logar no boot o que o servidor sabe de si — `mp.getServerSettings()` e `mp.getEspmLoadOrder()` — junto do pin declarado, e **recusar subir se divergirem**.

A segunda foi implementada para load order em 16/08/2026: manifesto assinado,
configuração e lista efetiva precisam ser idênticos antes de `db.init()`. Ainda
falta registrar o commit do binário e observar o retorno em runtime real.

---

## 3. O que quebra quando cada peça se mexe

| Peça | Quebra o quê | Detectado por |
|---|---|---|
| **Pin do SkyMP** | Superfície da API `mp`; lista de hooks; as 128 funções Papyrus; aplicabilidade de todo patch | `patches/validate.js` (pin) + `PAP-001` (gate de boot) — o segundo não existe ainda |
| **Skyrim 1.6.x** | SKSE, SkyrimPlatform, todos os plugins nativos | Launcher exige Steam `1.6.1170.0`; instalação real empacotada ainda é teste manual |
| **SKSE** | SkyrimPlatform não carrega | Erro no log do SKSE, na máquina do jogador |
| **SkyrimPlatform** | `makeEventSource` — o snippet roda contra a API `sp` daquela versão | Manifesto detecta qualquer byte JS/DLL diferente; harness in-game da API ainda falta e a falha funcional pode ser silenciosa |
| **Load order** | Todo FormID depois do plugin deslocado, e todo FormID persistido no nosso banco | Gate de paridade do launcher; ver [`PLUGIN_LOAD_ORDER_STRATEGY.md`](PLUGIN_LOAD_ORDER_STRATEGY.md) |
| **Modpack** | Hash do manifesto; índices; assets | Gate de paridade |
| **Gamemode** | Só quem logar depois recebe event source novo (`enableGamemodeDataUpdatesBroadcast: false`) | Nada |

Paridade de bytes não comprova compatibilidade funcional. O harness real de
Skyrim Platform e o gate de gamemode continuam sendo o trabalho apontado aqui.

A do SkyrimPlatform é a mais traiçoeira: um snippet de `makeEventSource` que usa uma API removida numa versão nova **não derruba o cliente e não avisa o servidor**. Ele só para de reportar. Some o `hit-events`, some o `_onUiEvent`, e a suíte continua verde porque nada disso é testável fora do jogo.

---

## 4. Procedimento de atualização

> **Nunca atualizar o SkyMP direto em produção.** Não porque alguém já fez — não há produção. Porque a hora de escrever isto é antes do primeiro dia em que haveria.

```
upstream novo
   ↓
branch de compatibilidade          ← nunca a main
   ↓
subir o pin no manifesto           ← patches/manifest.json
   ↓
diff da fronteira                  ← §4.1
   ↓
build                              ← servidor e, se mexeu, SkyrimPlatform
   ↓
testes automatizados               ← CI + patches/validate.js
   ↓
teste multiplayer real             ← §5, dois clientes, sem exceção
   ↓
validação do modpack               ← paridade e load order
   ↓
release
```

### 4.1 O diff da fronteira

O passo que existe porque a [auditoria de 14/08](../research/SKYMP_INTEGRATION_AUDIT.md) mostrou o que acontece sem ele. Toda subida de pin refaz **estas quatro perguntas**, com estes quatro comandos, no clone do upstream:

```bash
# 1) A API mp mudou?
grep -oE 'InstanceMethod\("[a-zA-Z_0-9]+"' skymp5-server/cpp/addon/ScampServer.cpp | sort

# 2) Os hooks de gamemode mudaram?
grep -rh 'return "on' skymp5-server/cpp/server_guest_lib/gamemode_events/*.cpp | sort

# 3) As funções Papyrus mudaram?
grep -rhoE 'Add(Method|Static)\(vm, "[^"]+"' \
  skymp5-server/cpp/server_guest_lib/script_classes/*.cpp | sort

# 4) A configuração de servidor mudou?
grep '^## ' docs/docs_server_configuration_reference.md
```

Método sumido, hook renomeado ou função Papyrus removida **falha a atualização**, e o nome sai no diff. É o mesmo raciocínio de `patches/validate.js`: transformar mudança silenciosa em falha nomeada.

`PAP-001` (gate de boot que confere as funções Papyrus contra o VM em runtime, via `_sp3*`) torna o passo 3 desnecessário. Enquanto ele não existir, o `grep` é o que temos.

### 4.2 Regras do procedimento

1. **Uma peça por vez.** SkyMP e SkyrimPlatform não sobem no mesmo ciclo. Quando os dois mudam, são dois ciclos — senão não há como saber qual quebrou.
2. **A branch de compatibilidade não recebe feature.** Só a subida e o que ela exigir.
3. **Rollback declarado antes de começar.** O pin anterior e o binário anterior ficam disponíveis. Se o teste da §5 falhar, volta — não conserta ao vivo.
4. **Se um patch parar de aplicar, ele é reavaliado, não remendado.** O primeiro passo é conferir se o upstream resolveu o problema — patch que sobreviveu ao próprio motivo é dívida.

---

## 5. Testes que uma atualização precisa passar

O briefing §19 lista onze itens. Aqui eles estão separados pelo que decide tudo: **quem consegue rodar isto.**

### Camada 1 — CI, sem jogo e sem banco

Roda hoje, em todo PR.

| Verificação | Comando |
|---|---|
| Suíte do gamemode | `npm test` em `skymp/gamemode` |
| Suítes de painel, api, bot e launcher | `npm test` em cada `apps/*` |
| Checks de sistema | `npm run test:systems` |
| Schema declarado pelas migrations | `npm run check:schema:list` |
| Typecheck contra `types/mp.d.ts` | `npm run typecheck` (informativo) |
| Registro de patches | `node patches/validate.js` |

**O que esta camada não prova:** nada de comportamento em jogo. Os testes do gamemode usam `mp` mockado, e mock aceita qualquer coisa — o aviso está no topo do `ci.yml` desde sempre, e a auditoria de 14/08 mostrou seis defeitos que ele descreve com precisão.

### Camada 2 — servidor real, sem jogador

**Não existe hoje, e é a maior alavanca deste documento.**

`mp.createBot()` cria um cliente de rede headless dentro do processo do servidor, e `misc/tests/` upstream é a prova de que dá para escrever teste de integração como gamemode: nove arquivos que criam ator, chamam Papyrus de verdade contra o VM de verdade e usam `assert`.

Um servidor de teste com ESM carregado e VM Papyrus real responde, sem nenhum jogador:

- toda função Papyrus que chamamos existe?
- `mp.kick` aceita o que passamos?
- o inventário fecha depois de `AddItem`/`RemoveItem`?
- `getEspmLoadOrder` bate com o manifesto?

**Isso é `BOUND-008`, e as seis falhas da auditoria de 14/08 teriam sido pegas aqui.**

### Camada 3 — dois clientes de verdade

Insubstituível. É a Fase 0, e o roteiro está em [`FASE_0_ROTEIRO.md`](FASE_0_ROTEIRO.md).

Toda atualização de pin repete o roteiro. Não uma versão reduzida — o roteiro.

| Item do briefing §19 | Camada |
|---|---|
| build | 1 |
| gamemode | 1 |
| client | 3 |
| connect | 2 (bot) → 3 (real) |
| spawn | 2 → 3 |
| combat | 3 |
| death | 2 (Papyrus e estado) → 3 (cena) |
| UI | 3 — o CEF não tem substituto |
| cell transitions | 3 |
| NPCs | 2 (config e carregamento) → 3 (comportamento) |
| patches | 1 (`git apply --check`) → 3 (efeito) |

**Quatro dos onze só existem na camada 3.** É a razão de a Fase 0 continuar bloqueando tudo, e a razão de a camada 2 valer o investimento: ela tira sete itens da fila da camada 3.

---

## 6. Tarefas

| ID | Tarefa | Depende de |
|---|---|---|
| `COMPAT-001` | Registrar o commit do SkyMP no artefato de build, ou conferir no boot | — |
| `COMPAT-002` | Unificar a versão do cliente: `version-check.js` e `package.json` do launcher | `BOUND-003` |
| `COMPAT-003` | O diff da fronteira (§4.1) como script versionado, não como quatro `grep` num documento | — |
| `PAP-001` | Gate de boot conferindo as funções Papyrus pela API `_sp3*` | — |
| `BOUND-008` | Camada 2: harness de integração com servidor real | — |

Nenhuma depende da Fase 0. `BOUND-008` **reduz** o que a Fase 0 precisa provar.

---

## 7. O que este documento não sabe

- **Em que commit o binário em `skymp/server/` foi construído.** É o `COMPAT-001`, e até ele existir a linha "SkyMP (pin)" da §1 é intenção, não fato verificado.
- **Se o SkyrimPlatform que os testadores instalam é o 2.9.0.** O modpack não fixa a versão.
- **Se o modpack atual sobe com 1.6.1170.** A decisão de Creation Club continua aberta.
- **Nada foi exercitado numa atualização de verdade.** O procedimento da §4 nunca rodou — o pin de hoje é o primeiro.
