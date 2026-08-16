# SkyMP upstream: o que existe e o que dá pra aproveitar

***Português** · [English](SKYMP_UPSTREAM_REFERENCE.en.md) · [Русский](SKYMP_UPSTREAM_REFERENCE.ru.md) · [Español](SKYMP_UPSTREAM_REFERENCE.es.md)*

Levantamento feito em 05/08/2026 direto do repositório oficial (`github.com/skyrim-multiplayer/skymp`, C++, 313 estrelas, último push 25/07/2026).

O objetivo é que ninguém aqui reinvente o que o SkyMP já entrega — e que ninguém tente usar o que ele não entrega.

---

## 1. Onde está a documentação oficial

Não é o wiki do GitHub e não é o `README`: é a pasta **`docs/`** do repositório. Os arquivos que valem:

| Arquivo | Sobre |
|---|---|
| `docs_serverside_scripting_reference.md` | A API `mp` do gamemode |
| `docs_events_system.md` | `mp.makeEventSource` — eventos cliente→servidor |
| `docs_properties_system.md` | Properties e sincronização |
| `docs_clientside_scripting_reference.md` | O objeto `ctx` dentro dos snippets de cliente |
| `docs_onhit_and_damage.md` | Pacote OnHit e fórmula de dano |
| `docs_server_ports_usage.md` | Portas e ferramentas de debug |
| `docs_database_drivers.md` | `file`, `mongodb`, `zip` |
| `docs_server_configuration_reference.md` | `server-settings.json` |

Para ler sem clonar (o `raw.githubusercontent.com` dá 404 via ferramentas de fetch):

```bash
gh api repos/skyrim-multiplayer/skymp/contents/docs/docs_events_system.md --jq '.content' | base64 -d
```

---

## 2. A descoberta que mais muda nosso código: `mp.makeEventSource`

Hoje **três serviços nossos fazem polling de 2 em 2 segundos** — `death-service.js` (detecta HP≤0 e picos de dano), `player-panel-service.js` (vitais do painel) e `voip-service.js` (volume por distância). Isso foi escrito assumindo que não havia alternativa.

Há. `mp.makeEventSource(nome, corpoDaFuncao)` injeta um trecho de JS no cliente que roda no loop do jogo e chama `ctx.sendEvent()` quando quiser; o servidor recebe via `mp._nomeDoEvento = (pcFormId) => {}`.

```js
// Nome customizado TEM que começar com underscore.
mp.makeEventSource("_onLocalDeath", `
  ctx.sp.on("update", () => {
    const pl = ctx.sp.Game.getPlayer();
    const isDead = pl.getActorValuePercentage("health") === 0;
    if (ctx.state.wasDead !== isDead) {
      if (isDead) ctx.sendEvent();
      ctx.state.wasDead = isDead;
    }
  });
`);
mp._onLocalDeath = (pcFormId) => { /* ... */ };
```

Esse exemplo é literalmente o da documentação oficial — e é exatamente o caso do nosso `death-service`.

**O que isso resolveria:**
- Morte detectada no frame em que acontece, em vez de até 2s depois. Numa cena de RP, 2s de atraso pra entrar em `DOWNED` é a diferença entre a cena funcionar e não funcionar.
- Fim do `checkDamageSpike` como heurística: em vez de inferir dano por queda de HP entre ticks, o cliente reporta o evento.
- Custo de CPU do servidor deixa de crescer linearmente com o número de jogadores conectados.

**A ressalva honesta:** o snippet roda no cliente, que é território não confiável (ver `MODS_AND_GAMEMODE_CONTRACT.md`). Um evento vindo dali é uma *dica*, não uma prova — o servidor continua tendo que validar. Para morte isso é aceitável (o pior caso é alguém forjar a própria morte). Para conceder item ou ouro, não é.

---

## 2.5 A fonte que faltava: `misc/tests/` upstream

A documentação em `docs/` descreve cinco métodos de `mp`. A API real é muito maior, e o lugar onde ela aparece **executando** é a pasta `misc/tests/` do repositório upstream — nove testes de integração que rodam contra um servidor de verdade.

Isso os torna mais confiáveis que qualquer documentação: são código que precisa passar.

```bash
gh api repos/skyrim-multiplayer/skymp/contents/misc/tests --jq '.[].name'
```

### O que eles resolveram para nós

**1. O formato do `self` do Papyrus — resolvido.** Todos os nove testes usam `{ type: 'form', desc: mp.getDescFromId(id) }`, nunca o FormID cru, inclusive para *argumentos* que sejam referências:

```js
mp.callPapyrusFunction("method", "ObjectReference", "RemoveAllItems",
    { type: "form", desc: mp.getDescFromId(actorId1) },
    [{ type: "form", desc: mp.getDescFromId(actorId2) }, false, false]);
```

Este projeto tinha 22 chamadas passando o FormID cru. Foram todas convertidas — ver `core/papyrus.js` (`actorRef`/`baseRef`).

Também aparece a distinção `form` vs `espm`: o ator é `form`, o Gold001 que se adiciona ao inventário dele é `espm`.

**2. `mp.onDeath` existe e traz o assassino.**

```js
mp.onDeath = (actorId, killerId) => { /* killerId é 0 quando não há autor */ };
mp.onRespawn = (actorId) => {};
```

Nosso `death-service.js` faz polling de 2s lendo `getActorValue('Health')`, e a documentação de combate deste projeto chegou a registrar que "não há hook confiável de quem atacou quem". Para o momento da morte — que é o que importa no anti-RDM — **há**. Isso torna o `logDeathContext` por proximidade uma aproximação desnecessária.

**3. Outros hooks e chamadas confirmados por teste:**

| | |
|---|---|
| `mp.onActivate = (target, caster) => {}` | Alguém usou um objeto/ator |
| `mp["onPapyrusEvent:OnItemAdded"] = fn` | Evento Papyrus arbitrário, por nome |
| `mp.createActor(profileId, pos, angleZ, cellOrWorld)` | Criar ator pelo servidor |
| `mp.set(id, "isDead", true)` | Matar diretamente, sem Papyrus |
| `mp.set(id, "inventory", {entries:[{baseId,count}]})` | **Escrever o inventário inteiro de uma vez** |
| `mp.get(id, "inventory").entries` | Ler o inventário |
| `mp.set(id, "spawnDelay", 0)` | Controlar o atraso de respawn |
| `mp.get(id, "spawnPoint")` | Ponto de spawn de um ator colocado |

O par `get/set` de `inventory` é notável: hoje `inventory-service.js` sincroniza item por item via `AddItem`. Um `set` único seria mais simples e atômico do lado do cliente.

---

## 2.6 Identidade e login: como o SkyMP realmente resolve `profileId`

Fonte: `skymp5-server/ts/systems/login.ts` e `skymp5-server/ts/settings.ts`.

Isto responde a pergunta em aberto de "como o gamemode sabe quem é o jogador" — item 1.6 do nosso `QA_REPORT_2026-08.md`.

**Existem dois modos, e a diferença é tudo:**

**`offlineMode: true`** — o cliente manda `gameData.profileId` e o servidor **acredita**. É o modo de laboratório. Qualquer um edita o `skymp_config.json` e vira outra pessoa.

**`offlineMode: false`** (padrão) — o cliente manda `gameData.session`, e o servidor **resolve a sessão contra um master API**:

```
GET  {master}/api/servers/{masterKey}/sessions/{session}
  →  { user: { id: number, discordId: string } }
```

O `profileId` passa a vir do master, não do cliente. **É aqui que a identidade vira confiável.**

O `master` padrão é `https://gateway.skymp.net`, mas é só uma string em `server-settings.json`.

### O caminho para o nosso item 1.6

Nós já temos tudo que esse endpoint precisa: OAuth do Discord, whitelist, e a tabela `launch_tickets` criada na migration v6. **O `apps/web` pode ser o nosso master API** — é um endpoint só:

1. `apps/web` implementa `GET /api/servers/:masterKey/sessions/:session`, resolvendo o ticket para `{ user: { id: accountId, discordId } }`.
2. `server-settings.json` aponta `master` para o nosso painel e define `masterKey`.
3. `offlineMode: false`.
4. O launcher grava o ticket como `skymp5-client-settings.txt.gameData.session`; o patch `launcher-session-settings-auth` o converte em `AuthGameData.remote`.

Feito isso, `whitelist.js` para de confiar no `profileId` do cliente sem precisar de nenhuma mudança nele: o `profileId` que chega **já é** o `accountId` validado.

Isso é bem mais simples do que o `/internal/session/resolve` que construímos no `apps/game-api`, e usa o mecanismo que o SkyMP já tem em vez de um paralelo.

### `mp.onLoginAttempt`

O `login.ts` chama, se existir:

```js
mp.onLoginAttempt = (profileId) => boolean;  // false recusa a conexão
```

É o ponto correto para whitelist e ban — o cliente recebe `loginFailedBanned`. Hoje reagimos ao evento nativo de conexão e ainda usamos `mp.kick` depois do spawn.

### `discordAuth` nativo no servidor

`server-settings.json` aceita:

```json
{
  "discordAuth": {
    "botToken": "...",
    "guilds": [{
      "guildId": "...",
      "banRoleId": "...",
      "hideIpRoleId": "...",
      "eventLogChannelId": "..."
    }]
  }
}
```

O servidor então, sozinho: exige que o jogador esteja no Discord, recusa quem tiver o cargo de ban, esconde o IP de quem tiver `hideIpRoleId`, e **posta os logins num canal**. Os cargos do Discord ficam disponíveis no gamemode via a property `private.discordRoles`.

Construímos parte disso no `apps/bot-discord`. Vale comparar antes de investir mais no nosso.

Nota: properties com prefixo `private.` não são visíveis pelo cliente.

---

## 2.7 Outros servidores RP em SkyMP

Encontrados por busca de código: `hijosdelasnieves/hijosdelasnieves-RP` (ativo em 29/07/2026), `reggiedroid/skymp-mop` (05/08/2026), `spike29011/Skymp-spike`.

Todos são cópias do upstream sem gamemode próprio publicado — o código de RP deles não está aberto. Servem como sinal de que o projeto tem outros servidores sérios em construção, não como fonte de solução.

O `sweettaffy-lib` (organização oficial) tem as **regras de RP** do servidor SweetTaffy em russo — útil como referência de design de regras, não de código.

---

## 3. Ferramentas de desenvolvimento que já existem e não usamos

Estas três são as que mais economizam tempo, e nenhuma exige escrever código:

### DevTools do Chromium na porta 9000
O navegador embutido expõe DevTools remoto. Abra **`localhost:9000`** no Chrome de verdade e você tem console, inspetor e breakpoints da nossa UI in-game.

Hoje `skymp/ui/index.html`, `player-panel.js` e `player-panel.css` são depurados **às cegas**. Isso muda com uma URL.

### Live reload da UI pela porta 1234
Se um WebPack dev server estiver rodando na porta 1234 na mesma máquina, o servidor SkyMP **faz proxy das requisições de UI pra ele**. Ou seja: dá pra iterar CSS e JS da UI sem reiniciar o servidor nem reconectar o cliente.

### Driver de banco `file` para teste
`databaseDriver: "file"` guarda o mundo num diretório, sem precisar de MongoDB. Já é o que nosso `server-settings.local.example.json` usa — vale saber que existe também `zip` (mesma coisa num arquivo só, prático pra snapshot antes de um teste destrutivo) e `mongodb` para produção.

---

## 4. Combate: correção de um entendimento anterior

Uma conclusão registrada antes neste projeto foi que "não existe hook confiável de quem atacou quem". Isso precisa de nuance:

**O pacote OnHit existe** e é rico (`docs_onhit_and_damage.md`):

```c++
uint32_t aggressor;   bool isBashAttack;   bool isHitBlocked;
bool isPowerAttack;   bool isSneakAttack;  uint32_t projectile;
uint32_t source;      uint32_t target;
```

O que **não** existe é um hook dedicado `mp.onHit` — a issue #1338 pediu isso e foi
fechada como won't fix.

> ⚠️ **Corrigido em 09/08/2026, e a correção importa.** "Não existe `mp.onHit`" é
> verdade; **"o dado não chega ao gamemode JS" é falso.** Ele chega, com o agressor
> já resolvido pelo servidor, por `mp["onPapyrusEvent:OnHit"]`. A cadeia inteira foi
> lida no código primário — ver **[§9.1](#91-o-achado-que-muda-uma-decisão-o-onhit-nativo-chega-ao-gamemode)**.
> As duas saídas listadas abaixo continuam válidas, mas **deixaram de ser as duas
> únicas**, e a terceira é mais barata que ambas.

Duas saídas, ambas viáveis:
1. **`makeEventSource` no cliente**, escutando o evento de hit do Skyrim Platform e mandando `{aggressor, target}` pro servidor. Barato, e melhor que a proximidade que usamos hoje — mas continua sendo o cliente falando.
2. **`IDamageFormula` em C++** — o SkyMP expõe uma interface justamente pra servidores customizados redefinirem a fórmula de dano. É onde o dado é confiável de verdade, mas exige build C++ do servidor.

**Isto deixou de ser teoria.** O servidor RP Red House implementou a saída 1 e o código é público — ver `REFERENCE_STUDY_SKYMP_RED_HOUSE.md` 4.1. Lá estão também os dois detalhes que custariam horas de depuração (o `0x14` do jogador local e a conversão obrigatória de FormID) e um aviso de performance que vale pra nós.

Enquanto nenhuma das duas for feita, o `/iniciar` + `checkDamageSpike` continua sendo o que temos: evidência por proximidade, não atribuição.

---

## 5. Cuidado com as portas

| Porta | Quem usa |
|---|---|
| 7777/UDP | SkyMP, sincronização (padrão) |
| 3000/HTTPS | UI do navegador embutido — **não configurável** |
| 9000 | DevTools do Chromium embutido |
| 1234 | WebPack dev server (live reload da UI) |
| 3001 | `apps/web` |
| 3002 | `apps/bot-discord` |
| 7758 | `apps/game-api` |
| 7778 | VOIP (`VOIP_PORT`) |

⚠️ **A porta de UI é `porta principal + 1` quando a principal é não-padrão.** Nosso `apps/launcher/.env.example` traz `VITE_SERVER_PORT=7757`, enquanto `skymp/config/server-settings.*.example.json` traz `"port": 7777`. Dois problemas nisso:

1. Os defaults **não batem** — o cliente tentaria 7757 enquanto o servidor escuta 7777.
2. Se alguém padronizar em 7757, a UI vai pra **7758 e colide com o `apps/game-api`**.

**Resolvido em 05/08/2026:** o launcher passou a usar 7777 (default e nos exemplos), alinhado com o `server-settings`. Fica o aviso no `.env.example`: mudar a porta principal pra um valor não-padrão desloca a UI e pode colidir com o `game-api`.

---

## 6. O que procuramos e não existe

- **Não há tipagem TypeScript pública da API `mp`.** O `skymp5-functions-lib` do upstream importa de um `src/` que não está no repositório — só o `index.ts` é público. Escrevemos a nossa em `skymp/gamemode/types/mp.d.ts`.
- **Nenhum outro servidor RP publicou seu gamemode.** Os três forks ativos encontrados são cópias do upstream sem código de RP aberto.
- **`skymp-ui-components`** (biblioteca de UI da org) está parada desde 2020. Não vale adotar.
- **`sweettaffy-lib`** é o conjunto de regras de RP do servidor SweetTaffy (em russo), não código — mas serve como referência de *design* de regras de servidor RP.
- **Releases**: a última é `sp-v2.6-beta`, de 2022. O projeto se desenvolve na branch `main`, não por release. Fixar em commit, não em tag.

---

## 7. Sugestão de aproveitamento, em ordem de custo-benefício

| | Ação | Esforço | Ganho |
|---|---|---|---|
| 1 | ✅ Alinhar as portas 7757/7777 nos exemplos | | Feito — era falha de conexão garantida |
| 2 | ✅ Escrever `types/mp.d.ts` | | Feito |
| 3 | ✅ Converter as 22 chamadas Papyrus pro formato de objeto | | Feito — ver 2.5 |
| 4 | Abrir `localhost:9000` na próxima sessão de teste da UI | Zero | Para de depurar UI às cegas |
| 5 | **Trocar o polling do `death-service` por `mp.onDeath`** | Horas | Morte no frame + `killerId` de graça. Substitui polling **e** a heurística de proximidade do anti-RDM |
| 6 | **`apps/web` vira o master API de sessão** (ver 2.6) | Um dia | Resolve o item 1.6 usando o mecanismo nativo, em vez do nosso `/internal/session/resolve` paralelo |
| 7 | `mp.onLoginAttempt` no lugar de whitelist pós-conexão + kick | Horas | Recusa no handshake, com mensagem correta pro cliente |
| 8 | Avaliar o `discordAuth` nativo antes de investir mais no bot | Horas | Ban por cargo, log de login e IP oculto sem código nosso |
| 9 | Subir o WebPack dev server na 1234 pro fluxo de UI | Um dia | Live reload da UI |

O item 4 vale fazer antes do teste in-game da Fase 1 (`QA_REPORT_2026-08.md`), porque afeta justamente esse teste. Os itens 5 a 8 mudam decisões de arquitetura que já tomamos — vale reler 2.5 e 2.6 antes de continuar construindo em cima delas.

---

## 8. Como o SkyMP resolve estado compartilhado

Levantamento de 09/08/2026, feito para dar base à
[`REVISAO_REALIDADE_COMPARTILHADA.md`](REVISAO_REALIDADE_COMPARTILHADA.md). Até
aqui este documento cobria a *API* do gamemode; esta seção cobre o **mecanismo
por baixo** — quem decide o que cada jogador vê, e em que formato o servidor
representa lugar e identidade de form.

### Disciplina de procedência

- **`[DOC]`** — lido no código-fonte primário do upstream (via
  `gh api repos/skyrim-multiplayer/skymp/contents/<caminho>`). É fato sobre o
  código na `main`.
- **`[DEEPWIKI]`** — vem da wiki gerada em `deepwiki.com`, **não** conferida
  contra o código. É evidência, não veredito: a wiki erra por omissão (ver 8.2).

### 8.1 O núcleo: `WorldState`, grid e vizinhança

**[DEEPWIKI]** ([2.5 World State Management](https://deepwiki.com/skyrim-multiplayer/skymp/2.5-world-state-management))
`WorldState` guarda todo form num `unordered_map<uint32_t, shared_ptr<MpForm>>`
(`LookupFormById`, `AddForm`, `DestroyForm`, em
`skymp5-server/cpp/server_guest_lib/WorldState.h`). O particionamento espacial é
um grid (`GridInfo` / `GridImpl<MpObjectReference*>`) consultado por
`GetNeighborsByPosition`. FormIDs `< 0xff000000` são de ESPM; `>= 0xff000000`
são gerados pelo servidor.

**[DEEPWIKI]** ([2.4.1](https://deepwiki.com/skyrim-multiplayer/skymp/2.4.1-mpactor-and-mpobjectreference),
[2.4.2](https://deepwiki.com/skyrim-multiplayer/skymp/2.4.2-actionlistener-and-event-handling))
"Vizinho" (*neighbour*) não é "quem está perto" em linha reta: é **quem está
inscrito nas atualizações daquele form**. `SendToNeighbours`
(`ActionListener.cpp:39-96`) primeiro valida que o remetente é dono do ator (ou
o *hoster* registrado em `worldState.hosters`) e só então retransmite. Entrar e
sair de grid gera inscrição/desinscrição — `PartOne::SetUserActor`
(`PartOne.cpp:175-221`) desinscreve o ator dos vizinhos e o tira do grid para
zerar a visibilidade.

**Consequência para nós:** o servidor **já mantém** a resposta de "quem vê quem".
`mp.getNeighborsByPosition` está exposto ao gamemode **[DOC]** — ver 8.3.

### 8.2 A wiki é incompleta: confira PropertyBindings no código

**[DEEPWIKI]** ([5.3](https://deepwiki.com/skyrim-multiplayer/skymp/5.3-properties-system))
lista as bindings padrão e **não menciona `locationalData`**. Isso levantaria
uma falsa suspeita sobre três serviços nossos. O código primário desmente:

**[DOC]** `skymp5-server/cpp/addon/property_bindings/PropertyBindingFactory.cpp`
— o mapa real de `CreateStandardPropertyBindings()`:

```
actorNeighbors  angle       appearance   baseDesc     equipment
inventory       isDead      isDisabled   isOnline     isOpen
locationalData  neighbors   onlinePlayers percentages pos
profileId       spawnPoint  type         worldOrCellDesc  idx
consoleCommandsAllowed  spawnDelay  templateChain  lastAnimEvent
respawnPercentages
```

`neighbors`, `actorNeighbors` e `onlinePlayers` são **built-in** — a lista de
vizinhos vem pronta do servidor.

### 8.3 A superfície real da API `mp`

**[DOC]** `skymp5-server/cpp/addon/ScampServer.cpp:84-143` — os `InstanceMethod`
registrados. Confirmam o que já usamos (`get`, `set`, `makeProperty`,
`makeEventSource`, `callPapyrusFunction`, `lookupEspmRecordById`,
`getActorsByProfileId`, `kick`, `place`) e revelam três que não usamos:

| Método | Para que serve aqui |
|---|---|
| `getNeighborsByPosition` | Vizinhança pelo grid do servidor, em vez do nosso O(n²) |
| `getDescFromId` / `getIdFromDesc` | Converte FormID ↔ `FormDesc` **sem adivinhar formato** (ver 8.5) |
| `findFormsByPropertyValue` | Busca por valor de property |

### 8.4 `locationalData`: a forma exata, de ida e de volta

**[DOC]** `property_bindings/LocationalDataBinding.cpp`.

**Leitura** (`mp.get`) devolve exatamente três campos:

```js
{ cellOrWorldDesc: "1a26f:Skyrim.esm",  // string, FormDesc::ToString()
  pos: [x, y, z],                        // array de 3 números
  rot: [x, y, z] }                       // array de 3 números — chama-se `rot`
```

**Escrita** (`mp.set`) exige os **três** campos, com esses nomes exatos, e chama
`MpActor::Teleport`. Campo ausente ou de tipo errado **lança**:
`NapiHelper::ExtractString` joga se o valor não for string,
`ExtractNiPoint3` joga se não for array (`skymp5-server/cpp/addon/NapiHelper.h:96,218`).
E só vale para atores: *"mp.set can only change 'locationalData' for actors, not
for refrs"*.

### 8.5 `FormDesc`: lugar e base são **string**, não hexadecimal

**[DOC]** `skymp5-server/cpp/server_guest_lib/FormDesc.cpp`. `ToString()` usa o
formato `"%0x%c%s"` → `shortFormId` em hex **sem prefixo `0x`**, delimitador `:`,
nome do arquivo:

```
"1a26f:Skyrim.esm"        ← forma canônica
"162e2"                    ← sem arquivo: vira 0xff000000 + id em ToFormId()
```

`FromString` sem delimitador **não falha** — cai no ramo sem arquivo e resolve
para a faixa de forms gerados pelo servidor. **É por isso que um `"0x162e2"`
escrito à mão não dá erro: ele aponta silenciosamente para outro lugar.**

`baseDesc` usa a mesma representação: **[DOC]**
`BaseDescBinding.cpp` devolve `FormDesc::FromFormId(refr.GetBaseId(), espmFiles).ToString()`.

### 8.6 `mp.onDeath`: existe, e **respawna sozinho** se você não bloquear

**[DOC]** `server_guest_lib/gamemode_events/DeathEvent.cpp`:

- O nome do hook é literalmente `"onDeath"`; os argumentos são
  `[actorId, killerId]`, com `killerId = 0` quando não há autor.
- `OnFireSuccess` chama **`actor->RespawnWithDelay()`**.

**[DOC]** `gamemode_events/GameModeEvent.cpp` — `Fire()` só chama
`OnFireSuccess` se **nenhum** listener devolveu `false`; caso contrário chama
`OnFireBlocked` (que `DeathEvent` não sobrescreve, ou seja: sem respawn).

**[DOC]** `skymp5-server/cpp/addon/ScampServerListener.cpp:41-129` — o contrato do
valor de retorno do handler JS:

| O handler `mp.onDeath` devolve | Efeito |
|---|---|
| `undefined` | **não bloqueia** → respawn automático acontece |
| `false` | **bloqueia** → o servidor não respawna |
| lança exceção | erro logado, **não bloqueia** → respawn acontece |

**[DOC]** `server_guest_lib/MpChangeForms.h:109` — `float spawnDelay = 25.0f`. O
atraso padrão é **25 segundos**, e há a property `spawnDelay` para mudá-lo.

### 8.7 Validação de entrada do cliente que o servidor já faz

**[DEEPWIKI]** ([2.4.2](https://deepwiki.com/skyrim-multiplayer/skymp/2.4.2-actionlistener-and-event-handling))
`ActionListener` valida antes de aceitar: `OnUpdateMovement` roda
`MovementValidation::Validate` contra teleporte impossível; `OnHit` checa
alcance de arma (`GetReach`, `fCombatDistance`), cadência (`CanHit`) e ator
morto; `OnChangeValues` corta regeneração impossível (`CropRegeneration`) e
reenvia correção. Custom events chegam por `OnCustomEvent` com
`actorId`, `eventName`, `argsJson`.

---

## 9. Varredura sistemática do DeepWiki (09/08/2026)

Até aqui, toda vez que uma decisão deste projeto esbarrou em "como o SkyMP faz
isso por baixo", a resposta veio de busca ad-hoc — às vezes achando, às vezes
não, sempre gastando uma rodada. Esta seção existe para que a próxima pergunta
já tenha resposta escrita.

A [wiki técnica do DeepWiki](https://deepwiki.com/skyrim-multiplayer/skymp) tem
~40 páginas geradas a partir do código-fonte real. **Ninguém deste projeto tinha
lido ela inteira.** Esta varredura leu as páginas onde decisão de projeto mora,
descartou o que é sobre compilar o upstream, e registrou só o que toca algo que
já existe ou está em aberto aqui.

### Decisão de forma: estende, não reorganiza

**Registrado por escrito porque a alternativa foi considerada e recusada.** O
volume novo caberia melhor numa reorganização por assunto do documento inteiro —
mas as seções 1 a 8 são **citadas por número de fora daqui**: o Anexo A.5 da
`CONSTITUICAO.md` aponta para a §4, o `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.5
aponta para a §2.5, e o §15 daquele documento também. Renumerar quebraria essas
referências em silêncio, que é exatamente a classe de erro que este documento
existe para evitar. Então: **§9 cresce por dentro, organizada por assunto, com
índice próprio.** Não há segundo documento concorrente.

### Disciplina de procedência (a mesma da §8, reforçada)

- **`[DOC]`** — abri o arquivo primário no upstream e li. É fato sobre a `main`.
- **`[DEEPWIKI]`** — vem só da wiki, **não conferido contra o código**. A wiki é
  gerada por IA a partir do código real: é melhor que fórum e melhor que chute,
  mas **simplifica e às vezes se contradiz** — esta varredura pegou a wiki se
  contradizendo sobre renderização de texto (§9.6) e discordando do que nós já
  tínhamos registrado sobre properties privadas (§9.5). Quando a wiki cita
  `arquivo:linha`, o caminho vai junto: é o atalho para quem for verificar.

**Não verifiquei as ~40 páginas contra o código-fonte** — isso inviabilizaria a
tarefa. Verifiquei linha a linha **um** achado: o da §9.1, porque ele muda uma
decisão que já está tomada e escrita.

### Índice da §9

| | Assunto |
|---|---|
| [9.1](#91-o-achado-que-muda-uma-decisão-o-onhit-nativo-chega-ao-gamemode) | 🔴 **O `OnHit` nativo chega ao gamemode** — `[DOC]`, alta relevância |
| [9.2](#92-arquitetura-de-servidor-loop-boot-e-configuração) | Arquitetura de servidor: loop, boot e configuração |
| [9.3](#93-persistência-mpchangeform-e-o-cadáver) | Persistência, `MpChangeForm` e o cadáver |
| [9.4](#94-sincronização-o-que-o-cliente-manda-quando-e-com-que-garantia) | Sincronização: o que o cliente manda, quando, e com que garantia |
| [9.5](#95-sistemas-de-jogo-properties-comandos-e-o-que-dá-pra-roubar-do-sweetpie) | Sistemas de jogo: properties, comandos, SweetPie |
| [9.6](#96-cliente-renderização-de-entidade-e-de-texto-o-caso-da-nametag) | Cliente: renderização de entidade e de texto (nametag) |
| [9.7](#97-glossário-de-termos-do-upstream) | Glossário de termos do upstream |
| [9.8](#98-o-que-isto-não-cobre) | **O que isto não cobre** |

---

### 9.1 O achado que muda uma decisão: o `OnHit` nativo **chega** ao gamemode

**`[DOC]`** — cadeia inteira lida no código primário do upstream, `main`, em
09/08/2026. É o único achado desta varredura que foi verificado linha a linha, e
foi verificado porque contradiz algo que este repositório já tinha escrito.

**O que este projeto acreditava** (§4 deste documento, e o cabeçalho do
`core/hit-events.js`): o pacote OnHit existe no C++, mas **não é exposto ao
gamemode JS**; a issue #1338 pediu e foi fechada como won't fix; logo as únicas
saídas são `makeEventSource` no cliente (o que fazemos) ou `IDamageFormula` em
C++.

**O que o código diz:** não existe `mp.onHit`. **Mas o evento chega assim mesmo**,
por outro nome, com o agressor **já resolvido e validado pelo servidor**:

```js
mp["onPapyrusEvent:OnHit"] = (
  targetFormId,   // number — FormID de quem levou o golpe
  akAggressor,    // { type: 'form', desc: '...' }  ← quem bateu, resolvido pelo servidor
  akSource,       // { type: 'espm', desc: '...' }  ← arma/feitiço
  akProjectile,   // null quando não há projétil
  abPowerAttack, abSneakAttack, abBashAttack, abHitBlocked  // booleanos
) => { /* ... */ };
```

**A cadeia, arquivo por arquivo:**

| # | Onde | O que acontece |
|---|---|---|
| 1 | `ActionListener.cpp:1006` | `ActionListener::OnHit` recebe a `HitMessage` do cliente |
| 2 | idem, ≈L1019-1037 | **O servidor traduz `0x14` sozinho** — ver abaixo |
| 3 | idem, ≈L1043-1080 | Valida: agressor é do usuário (ou o *hoster* registrado), mesma célula/worldspace, distância ≤ 4096 unidades (dispensada em tiro de arco/besta) |
| 4 | idem, ≈L1080+ | Agressor morto não pode atacar; alcance de arma e cadência (`CanHit`) |
| 5 | `ActionListener.cpp:1215` e `:1256` | `OnWeaponHit` e `OnSpellHit` chamam `SendPapyrusOnHitEvent` |
| 6 | `ActionListener.cpp:1410-1425` | Monta 7 `VarValue` e chama `target->SendPapyrusEvent("OnHit", …)` |
| 7 | `MpForm.cpp:34-40` | `SendPapyrusEvent` constrói um `PapyrusEventEvent` e chama `.Fire(parent)` |
| 8 | `gamemode_events/PapyrusEventEvent.cpp:18-19` | O nome do evento vira `"onPapyrusEvent:" + "OnHit"` |
| 9 | `gamemode_events/GameModeEvent.cpp` | `Fire()` percorre os listeners chamando `OnMpApiEvent` |
| 10 | `addon/ScampServerListener.cpp` (≈L41-129) | Procura `mp["onPapyrusEvent:OnHit"]`; se for função, chama com os args JSON **+** os 7 args Papyrus convertidos |
| 11 | `addon/PapyrusUtils.h:14-49` | Objeto Papyrus → `{ type: 'form' \| 'espm', desc: '<FormDesc>' }` |

**Três consequências diretas para o `core/hit-events.js`:**

1. **O `0x14` é problema do servidor, não nosso.** `ActionListener.cpp` faz
   literalmente `if (hitData.aggressor == 0x14) { aggressor = myActor;
   hitData.aggressor = aggressor->GetFormId(); }`, e o mesmo para `target`. Nosso
   `hit-events.js` mantém `const JOGADOR_LOCAL = 0x14` e traduz por conta própria
   porque o snippet de cliente reporta cru — por este caminho, a tradução já vem
   feita e correta.
2. **O agressor chega no formato que já usamos.** `{ type: 'form', desc: … }` é
   exatamente o `FormDesc` do `core/papyrus.js` (`actorRef`/`baseRef`) e da §8.5.
   Nada de novo para aprender, nada de hexadecimal para adivinhar.
3. **É evidência *validada pelo servidor*, não relato cru do cliente.** Isso não
   apaga a regra do `MODS_AND_GAMEMODE_CONTRACT.md` — a origem ainda é uma
   mensagem `MsgType::OnHit` que o cliente decidiu mandar —, mas **é um degrau
   acima** do que temos: hoje aceitamos o que o snippet disser; por ali, o
   servidor já descartou golpe de ator morto, de célula diferente, fora de
   alcance e fora de cadência **antes** de nos contar.

**Os limites, ditos antes que alguém se empolgue:**

- **Bloquear não impede o dano.** Devolver `false` só impede o `OnFireSuccess` —
  isto é, o despacho para a VM Papyrus. `SendPapyrusOnHitEvent` **descarta** o
  retorno de `Fire()`, e o cálculo de dano roda logo depois, dentro de
  `OnWeaponHit`/`OnSpellHit`. **Isto é observação, não enforcement.**
- **O evento é do alvo.** Ele dispara no form que *levou* o golpe. Se o alvo não
  for ator, o dano é pulado mas o evento dispara igual.
- **Continua sendo `[DOC]` de upstream, não exercitado aqui.** Nada disso rodou
  neste servidor — como todo o resto, depende de alguém conectado (Fase 0).

> **Encaminhamento — não é para implementar agora.** Isto é achado, e o lugar de
> decidir é a revisão de realidade compartilhada
> (`PROMPT_REVISAR_REALIDADE_COMPARTILHADA.md`). O que fica registrado é que
> **existe um caminho de coleta de golpe que hoje não estamos usando**, mais
> barato que o `IDamageFormula` em C++ e mais confiável que o `makeEventSource`
> atual — e que a §4 deste documento estava parcialmente errada sobre isso desde
> que foi escrita.

---

### 9.2 Arquitetura de servidor: loop, boot e configuração

**[DEEPWIKI]** ([2.3 PartOne e game loop](https://deepwiki.com/skyrim-multiplayer/skymp/2.3-partone-and-game-loop))
`PartOne::Tick()` (`PartOne.cpp:146-151`) faz três coisas em ordem:
`TickPacketHistoryPlaybacks()`, `TickDeferredMessages()` (mensagens enfileiradas
em lote) e `WorldState::Tick()` (timers, promises, ciclo de vida de entidade).

**[DEEPWIKI]** ([2.1 TypeScript Orchestration](https://deepwiki.com/skyrim-multiplayer/skymp/2.1-typescript-server-orchestration))
Quem chama esse tick é a camada TS: um laço infinito chamando `server.tick()`
**a cada 1 ms** (`skymp5-server/ts/index.ts:222-235`).

> **Relevância.** O Anexo A.5 da Constituição orça o frame do servidor contra
> "três serviços com polling de 2 s". Este é o número que faltava do outro lado
> da conta: o laço-base é de 1 ms, e **todo `setInterval` nosso divide o mesmo
> processo Node com ele.** Reforça — não enfraquece — a regra que o
> `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.1 já tinha escrito: *ativação de mobs
> hostis não pode adicionar nenhum timer novo.*

**[DEEPWIKI]** (mesma página) `PartOne::SetUserActor` (`PartOne.cpp:175-221`)
desinscreve o ator dos vizinhos, tira do grid, grava em `serverState.actorsMap` e
**chama `RespawnWithDelay()` se o ator estiver morto**. Confirma por outro
caminho o que a §8.6 já registrou como `[DOC]`: respawn automático é o padrão, e
quem não quiser precisa bloquear.

**[DEEPWIKI]** ([2.1](https://deepwiki.com/skyrim-multiplayer/skymp/2.1-typescript-server-orchestration))
Boot e hot-reload: o gamemode é **copiado para arquivo temporário** antes de
carregar, para escapar do cache de módulos do Node (`ts/index.ts:38-61`);
`globalThis.mp = server` é o que faz o `mp` existir (`ts/index.ts:82`); e
`server.clear()` zera o estado do gamemode antes de recarregar (`ts/index.ts:126`).

> **Relevância.** `server.clear()` num hot-reload significa que **todo estado que
> nossos serviços guardam em memória some sem aviso**. É argumento a favor da
> disciplina que já praticamos (teto de rendimento por consulta ao ledger, nunca
> por contador em memória — `HOSTILE_MOB_ACTIVATION_DECISION.md` §4.2) e vale
> como aviso para quem for escrever o próximo serviço.

**[DEEPWIKI]** (mesma página) `Settings` funde `server-settings.json` com **JSON
buscado de repositórios do GitHub** via `additionalServerSettings` (campos
`type`, `repo`, `ref`, `pathRegex`, `token`), com cache em
`server-settings-dump.json` e verificação SHA512 (`ts/settings.ts:134-311`).

> **Relevância.** É um caminho por onde **configuração de produção pode vir de um
> repositório de terceiro**. Não usamos, e vale saber que existe antes de alguém
> copiar um `server-settings.json` de exemplo que traga isso ligado.

---

### 9.3 Persistência, `MpChangeForm` e o cadáver

**[DEEPWIKI]** ([2.5.1 Database and Persistence](https://deepwiki.com/skyrim-multiplayer/skymp/2.5.1-database-and-persistence))
Quatro drivers, e um deles não estava na nossa §3:

| Driver | O que faz | Fonte citada pela wiki |
|---|---|---|
| `MongoDatabase` | Coleção `changeForms`, bulk write, chaves restritas viram hash SHA-256 | `database_drivers/MongoDatabase.cpp:33,72-75,87-107,143-228` |
| `FileDatabase` | Um JSON por `MpChangeForm`, escrita atômica via `rename` | `database_drivers/FileDatabase.cpp:37-55` |
| `ZipDatabase` | Mesma coisa dentro de um `.zip` | `database_drivers/ZipDatabase.cpp:40-63` |
| **`MigrationDatabase`** | **Migra entre drivers**, em lotes de 1000 | `database_drivers/MigrationDatabase.cpp:94-117` |

**[DEEPWIKI]** Escrita é assíncrona em thread própria (`SaverThreadMain`),
juntando vários `MpChangeForm` num `UpsertTask` por lote
(`viet/include/save_storages/AsyncSaveStorage.h:25-61,230-234,248-250`).

> **Relevância 1 — o `MigrationDatabase` responde uma pergunta que ainda não
> tínhamos feito.** A §3 registrou que `file` é o driver de teste e `mongodb` o
> de produção, sem dizer como se vai de um ao outro. Existe caminho pronto.
>
> **Relevância 2 — persistência é assíncrona e em lote.** Nenhuma escrita de
> estado de mundo é síncrona. Para nós isso é bom (não bloqueia o frame) e é
> aviso (o que o `mp.set` acabou de mudar **ainda não está no disco**; um crash
> entre o `set` e o flush perde a mudança). O ledger em MySQL, que é nosso e
> síncrono, continua sendo a fonte da verdade para patrimônio — o que é
> exatamente a razão de a regra "patrimônio pelo `transaction-service`" existir.

**[DEEPWIKI]** ([2.4.1 MpActor e MpObjectReference](https://deepwiki.com/skyrim-multiplayer/skymp/2.4.1-mpactor-and-mpobjectreference))
Campos de `MpChangeForm` com linha citada — todos em
`server_guest_lib/MpChangeForms.h`:

| Campo | Linha | O que guarda |
|---|---|---|
| `isOpen` | 76 | contêiner/porta aberto |
| `isDisabled` | 79 | "escondido do mundo" |
| `isDead` | 85 | estado de morte |
| `equipment` | 94 | itens e magias equipados |
| `actorValues` | 98 | percentuais de Health/Magicka/Stamina |
| `templateChain` | 105 | (já usado no `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.4b) |
| `spawnDelay` | 109 | (já `[DOC]` na §8.6: padrão 25 s) |

**[DEEPWIKI]** (mesma página) Inventário e contêiner: `AddItem()`,
`RemoveItem()`, `PutItem()` (contêiner→ator) e `TakeItem()` (ator→contêiner)
ficam em `MpObjectReference.cpp:815-952`. `Activate()` — que dispara o
`ActivateEvent` do gamemode e o `OnActivate` do Papyrus — em
`MpObjectReference.cpp:438-503`. `Delete()` em `:954-959`.

> **Relevância — é a pergunta do cadáver, e a wiki não a fecha.** O
> `HOSTILE_MOB_ACTIVATION_DECISION.md` §10 e §16 dizem que a feature inteira
> depende de o servidor conseguir controlar o inventário de um cadáver. O que
> esta leitura acrescenta: **inventário é campo de `MpChangeForm`**, ou seja
> estado *do servidor*, persistido, com `PutItem`/`TakeItem` passando pelo
> `ActionListener` — o que aponta para "sim, dá". O que ela **não** dá é o
> comportamento do saque de cadáver vanilla, que é o caso específico. A página
> `2.4.1` menciona `DeathStateContainerMessage` mas **não detalha resolução de
> death item**, e eu não abri o código. **A Peça 2 (`corpse-probe.js`) continua
> sendo o que responde.** Isto é indício a favor, não veredito.

---

### 9.4 Sincronização: o que o cliente manda, quando, e com que garantia

**[DEEPWIKI]** ([3.2.3 Input Capture and State Synchronization](https://deepwiki.com/skyrim-multiplayer/skymp/3.2.3-input-capture-and-state-synchronization))
Os números que ninguém aqui tinha:

| O que | Cadência | Confiabilidade | Fonte citada |
|---|---|---|---|
| `UpdateMovement` | **~130 ms por ator** | UNRELIABLE | `sendInputsService.ts:120-135` |
| `ChangeValues` (HP/MP/SP) | **só se mudou**; sem mudança, 2000 ms | UNRELIABLE | `sendInputsService.ts:137-196` |
| `OnHit` | por evento | **RELIABLE** | `hitService.ts:15-69` |
| `SpellCast` | por evento | **RELIABLE** | — |

Detalhe do `ChangeValues`: atrasa 500 ms durante conjuração (**exceto quando
`health = 0`**) e é suprimido enquanto o serviço de morte do cliente está
ocupado.

> **Relevância 1 — explica o teto de precisão do `death-service`.** O HP que o
> servidor lê chega, no melhor caso, quando o cliente decide que mudou; na
> ausência de mudança, de 2 em 2 segundos. **Nosso polling de 2 s estava lendo um
> valor que também se atualiza a cada ~2 s** — ou seja, o atraso real era o dobro
> do que supúnhamos. É mais um argumento para o caminho de evento
> (`mp.onDeath`, já adotado via `core/death-events.js`) contra o de polling.
>
> **Relevância 2 — a exceção do `health = 0` é desenho a favor.** O upstream
> tratou morte como o caso que não pode atrasar. Nossa arquitetura foi para o
> mesmo lado por conta própria.

**[DEEPWIKI]** (mesma página) O `HitService` do cliente **já filtra**: descarta
golpe em objeto estático e só aceita atacante que seja o jogador local ou um NPC
*hospedado* por ele.

> **Relevância — nosso `hit-events.js` reimplementa parte disso.** O snippet que
> injetamos por `makeEventSource` faz sua própria captura de `hit`. O cliente
> nativo já captura, filtra e manda como RELIABLE — e o que ele manda é
> exatamente o que a §9.1 mostra chegando ao gamemode. **Estamos coletando em
> paralelo a um canal que já existe, já é filtrado e já é validado no servidor.**

**[DEEPWIKI]** ([3.2 Client Synchronization](https://deepwiki.com/skyrim-multiplayer/skymp/3.2-client-synchronization))
*Hosting*: o cliente mantém `storage['hosted']` com os IDs remotos que ele
controla localmente — é assim que um jogador "hospeda" o movimento de um NPC
(`remoteServer.ts:133-155`). Do lado do servidor é o `worldState.hosters` que a
§8.1 já registrou.

> **Relevância.** É o mecanismo pelo qual **a IA de um mob roda na máquina de
> algum jogador**. Confirma, por baixo, a premissa do
> `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.1 (IA e dano de criatura custam zero no
> nosso frame) e a da §3.3/§4.1 (o servidor não tem verbo para impedir um urso de
> andar até a zona segura — quem decide o caminho dele é um cliente).

---

### 9.5 Sistemas de jogo: properties, comandos, e o que dá pra roubar do SweetPie

**[DEEPWIKI]** ([5.3 Properties System](https://deepwiki.com/skyrim-multiplayer/skymp/5.3-properties-system))
Properties customizadas são guardadas pelo `DynamicFields` como **strings JSON
num `unordered_map<string,string>`** (`server_guest_lib/DynamicFields.h:30`).

⚠️ **Divergência que vale conferir antes de confiar.** A wiki diz que os
prefixos de privacidade são **`__p_`** (privado) e **`__pi_`** (privado indexado),
citando `addon/property_bindings/CustomPropertyBinding.cpp:27-31`. A **§2.6 deste
documento** registra o prefixo como **`private.`**. Os dois não podem estar
certos. Nenhum dos dois foi lido no código nesta rodada — **quem for usar
property privada confere primeiro**, porque errar aqui vaza para o cliente em
silêncio, que é o pior modo de falha possível.

**[DEEPWIKI]** ([5.4 Command System](https://deepwiki.com/skyrim-multiplayer/skymp/5.4-command-system))
Comando de console do cliente vira `MsgType::ConsoleCommand`, cai em
`ActionListener::OnConsoleCommand` e é executado por `ConsoleCommands::Execute`.
A permissão é o `EnsureAdmin`, que checa a flag `ConsoleCommandsAllowedFlag` do
`MpActor` — ou se o servidor liberou para todos
(`ConsoleCommands.cpp:58-72`, execução em `:74-193`;
`consoleCommandsService.ts:18-34,81-83,93-102`).

> **Relevância.** Casa com a property `consoleCommandsAllowed` que a §8.2 já
> lista como binding padrão. É **permissão nativa, por ator, do lado do
> servidor** — uma camada que nosso `admin-service` hoje não usa. Vale conferir
> se ela está ligada por engano antes do primeiro teste com gente de fora.

**[DEEPWIKI]** ([5.2 SweetPie PvP](https://deepwiki.com/skyrim-multiplayer/skymp/5.2-sweetpie-pvp-game-mode))
**Conferido antes de descartar, como o plano mandava.** É um modo PvP em arena
(Markarth, Riften, Whiterun, Windhelm) — em quase tudo, o oposto de Heavy RP.
**Duas peças sobrevivem ao descarte:**

1. **`IDamageFormula` é ponto de extensão real**, com mais de uma implementação
   convivendo (vanilla, SweetPie, variantes de magia) —
   `formulas/SweetPieDamageFormula.cpp:68-113`, `formulas/TES5DamageFormula.cpp:127-240`.
   É a "saída 2" da §4 deste documento, e agora tem exemplo de uso.
2. **O registro de pontos por nome (`pointsByName`)** é independente do PvP — é
   um registro de `locationalData` nomeado, que é a forma que nosso
   `RESPAWN_CELL`/spawn points teria se um dia deixar de ser constante no código.

Implementação principal em `skymp5-functions-lib/index.ts:1-598` (exposição a
Papyrus em `:262-335`) — que é, aliás, **o único gamemode completo publicado**
que existe para ler.

---

### 9.6 Cliente: renderização de entidade e de texto (o caso da nametag)

**[DEEPWIKI]** ([3.1.1 JavaScript API and Plugin System](https://deepwiki.com/skyrim-multiplayer/skymp/3.1.1-javascript-api-and-plugin-system))
A `TextApi` do SkyrimPlatform, via um singleton `TextsCollection`
(`skyrim-platform/src/platform_se/skyrim_platform/TextApi.cpp:8-181`):

| Função | O que faz |
|---|---|
| `CreateText()` | cria a entrada de texto |
| **`SetTextRefr()`** | **prende o texto a uma referência do jogo, por FormId** |
| `SetTextPos()` | posiciona em coordenada de tela |
| `GetTextsToDraw()` | entrega ao renderizador o que está visível |

**[DEEPWIKI]** ([3.1.2 Event System and Text Rendering](https://deepwiki.com/skyrim-multiplayer/skymp/3.1.2-event-system-and-text-rendering))
O desenho é overlay DirectX (`tilted/ui/DX11RenderHandler.cpp:72-97`), com fontes
`.spritefont` carregadas de `Data/Platform/Fonts/` (`:176-194`). Propriedades:
posição, cor RGBA 0–1, rotação em radianos, escala.

⚠️ **A wiki se contradiz aqui, e isso é informação sobre a wiki.** A página
`3.1.2` afirma que as coordenadas são **só de tela** e que world-space "não é
especificado"; a página `3.1.1` documenta `SetTextRefr()`, que prende texto a uma
referência do mundo. **A segunda é mais específica e provavelmente a certa**, mas
nenhuma foi conferida no código.

> **Relevância — é exatamente a pergunta da nametag.** O
> `NAMETAG_IDENTITY_SYSTEM.md` e o `nametag-service.js` (módulo `lab`, desligado)
> precisam saber se o texto acompanha o ator sozinho ou se alguém tem que
> projetar mundo→tela a cada frame. **`SetTextRefr()` aponta para "acompanha
> sozinho"**, o que seria bem mais barato do que projetar. Fica registrado como
> `[DEEPWIKI]` com o arquivo para conferir (`TextApi.cpp:8-181`) — é a primeira
> coisa a abrir quando a nametag voltar à mesa.

**[DEEPWIKI]** ([3.2.2 WorldView and Entity Rendering](https://deepwiki.com/skyrim-multiplayer/skymp/3.2.2-worldview-and-entity-rendering))
Entidade remota é criada no cliente com `player.placeAtMe(baseForm, 1, true, true)`
(`view/formView.ts:169-186`). **Todos os `FormView` são destruídos quando o
jogador troca de worldspace/célula** (`view/worldView.ts:71-85`), e cada um se
autodestrói se o `worldOrCell` do modelo divergir (`view/formView.ts:40-55`).

> **Relevância.** Qualquer coisa nossa presa a uma entidade renderizada — nametag
> à frente — **morre na troca de célula e precisa ser recriada.** Não é bug, é o
> ciclo de vida. Melhor saber antes de depurar "a etiqueta sumiu quando entrei na
> taverna".

**[DEEPWIKI]** ([3.1.1](https://deepwiki.com/skyrim-multiplayer/skymp/3.1.1-javascript-api-and-plugin-system))
Miudezas úteis: plugins de cliente saem de `Data/Platform/Plugins/` (`.js` +
`-settings.txt` como JSON); `skyrimPlatform.storage` **sobrevive a hot-reload mas
não a reinício do jogo**; JS roda em thread própria, com fila para o que precisa
da thread do jogo.

> **Relevância.** "Sobrevive a reload, não a reinício" é a mesma classe de aviso
> da §9.2 sobre `server.clear()`: **estado em memória, dos dois lados, é
> descartável por construção.**

---

### 9.7 Glossário de termos do upstream

**[DEEPWIKI]** ([7 Glossary](https://deepwiki.com/skyrim-multiplayer/skymp/7-glossary)).
Registrado como referência de vocabulário — é o que economiza a próxima releitura:

| Termo | Definição do upstream |
|---|---|
| **Hoster** | o cliente que tem autoridade sobre o movimento de um NPC (§9.4) |
| **Neighbour** | objetos próximos dentro da partição do grid — mas ver §8.1: na prática é *quem está inscrito nas atualizações do form* |
| **ChangeForm** | conceito da Bethesda para delta de um record; aqui é `MpChangeForm` |
| **FormDesc** | FormID + nome do arquivo ESP/ESM, para sobreviver a mudança de load order (§8.5) |
| **ESPM / libespm** | biblioteca que lê `.esm`/`.esp`/`.esl` — é como o servidor entende o jogo base |
| **SpSnippet** | trecho de Papyrus executado dinamicamente, servidor ou cliente (§ da wiki 2.7) |
| **PartOne** | a classe coordenadora do servidor nativo |
| **ScampServer** | o addon N-API que embrulha o C++ para o Node |
| **WorldState** | o gerenciador central de todas as entidades carregadas (§8.1) |
| **VarValue** | o tipo variante da VM Papyrus (string, int, float ou referência) |

---

### 9.8 O que isto **não** cobre

Registrado para que ninguém releia achando que ainda não foi feito.

**Aberto e sem nada relevante novo** — leitura feita, resultado magro:

| Página | Veredito |
|---|---|
| [1.2 System Architecture Overview](https://deepwiki.com/skyrim-multiplayer/skymp/1.2-system-architecture-overview) | Confirma o modelo autoritativo que a §8 já cobre. Nada novo. Não diz o que o servidor **não** controla — que é justamente o que nos interessa |
| [1.3 Repository Structure](https://deepwiki.com/skyrim-multiplayer/skymp/1.3-repository-structure) | Lista diretórios (`libespm`, `viet`, `papyrus-vm`, `savefile`…). **Nem menciona `misc/tests` nem `docs/`** — as duas fontes que mais nos serviram (§2.5, §1). Aqui a nossa §1 é melhor que a wiki |
| [2.2 ScampServer Native Addon](https://deepwiki.com/skyrim-multiplayer/skymp/2.2-scampserver-native-addon) | A §8.3 já tem a lista real, lida no `ScampServer.cpp`. A wiki é mais pobre — e afirma que só `connect`/`disconnect`/`packet` chegam ao JS, **o que a §9.1 desmente** |
| [3.2.2 WorldView and Entity Rendering](https://deepwiki.com/skyrim-multiplayer/skymp/3.2.2-worldview-and-entity-rendering) | Rendeu só o ciclo de vida da §9.6. Não fala de nametag e **não fala de custo de spawn de muitos atores** — a incógnita nº 1 do `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.2 **continua sem resposta na wiki** |
| [5.2 SweetPie PvP](https://deepwiki.com/skyrim-multiplayer/skymp/5.2-sweetpie-pvp-game-mode) | Conferido antes de descartar. É PvP de arena. Sobraram as duas peças da §9.5 |

**Não aberto de propósito** — é sobre compilar e contribuir com o upstream, não
sobre como o jogo se comporta em produção:

- `1.1` Getting Started
- `4` Build System and Deployment **inteiro** — `4.1` CMake, `4.2` vcpkg,
  `4.3` CI/CD, `4.4` Deployment, `4.5` Distribution and Artifacts
- `6` Development Guide **inteiro** — `6.1` Environment Setup,
  `6.2` Contribution Workflow, `6.3` Testing, `6.4` Server Operations

> Ressalva honesta sobre duas delas: **`6.3` Testing** e **`6.4` Server
> Operations** são as que têm chance real de virar úteis — a primeira se
> formos escrever teste de integração contra servidor de verdade (o caminho que a
> §2.5 abriu), a segunda quando a Fase 0 finalmente subir um servidor. Ficaram de
> fora desta rodada por prioridade, não por irrelevância.

**Perguntas deste projeto que a wiki inteira não respondeu:**

1. **Custo de sincronização por ator ativo × jogadores.** Nenhuma página dá
   número. Continua sendo o que só o censo (`fauna-census.js`) mede.
2. **Comportamento de saque de cadáver vanilla.** A §9.3 dá indício a favor e
   nada mais. Continua sendo a Peça 2 (`corpse-probe.js`).
3. **Se estatística de NPC escala por nível do jogador no cliente.** O
   `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.4(c)(2) já registrava esse limite; a
   wiki não o toca. Segue em aberto.

**Lista nivelada — não refazer.** A pista da wiki sobre `espm::Loader` e
resolução de lista nivelada (§8.1) **já foi verificada contra o código primário**
em 09/08/2026 e subiu a `[DOC]`: está no
[`HOSTILE_MOB_ACTIVATION_DECISION.md`](HOSTILE_MOB_ACTIVATION_DECISION.md) §7.4(b),
com arquivos, funções e a tabela de quem passa qual `pcLevel`. **Duas rodadas não
deveriam refazer a mesma verificação** — quem chegar aqui pelo
`PROMPT_FECHAR_PERGUNTA_ESCALA_MOB.md` deve ler lá, não reabrir.

---

## Fontes

- [skyrim-multiplayer/skymp](https://github.com/skyrim-multiplayer/skymp) — repositório oficial, pasta `docs/`
- [Game Mode Framework — DeepWiki](https://deepwiki.com/skyrim-multiplayer/skymp/5.1-game-mode-framework)
- **DeepWiki, páginas de arquitetura usadas na seção 8** — [1.2 System Architecture](https://deepwiki.com/skyrim-multiplayer/skymp/1.2-system-architecture-overview) · [2.3 PartOne e game loop](https://deepwiki.com/skyrim-multiplayer/skymp/2.3-partone-and-game-loop) · [2.4.1 MpActor/MpObjectReference](https://deepwiki.com/skyrim-multiplayer/skymp/2.4.1-mpactor-and-mpobjectreference) · [2.4.2 ActionListener](https://deepwiki.com/skyrim-multiplayer/skymp/2.4.2-actionlistener-and-event-handling) · [2.5 World State](https://deepwiki.com/skyrim-multiplayer/skymp/2.5-world-state-management) · [2.6 Networking](https://deepwiki.com/skyrim-multiplayer/skymp/2.6-networking-and-message-processing) · [5.3 Properties](https://deepwiki.com/skyrim-multiplayer/skymp/5.3-properties-system)
- **Código primário citado como `[DOC]` na seção 8** — `PropertyBindingFactory.cpp`, `LocationalDataBinding.cpp`, `BaseDescBinding.cpp`, `NeighborsBinding.cpp`, `WorldOrCellDescBinding.cpp`, `FormDesc.cpp`/`.h`, `ScampServer.cpp`, `ScampServerListener.cpp`, `NapiHelper.h`, `MpChangeForms.h`, `MpActor.cpp`, `gamemode_events/DeathEvent.cpp`, `gamemode_events/GameModeEvent.cpp`
- [docs/docs_skyrim_platform.md](https://github.com/skyrim-multiplayer/skymp/blob/main/docs/docs_skyrim_platform.md)
- [Issue #1338 — onHit para gamemode](https://github.com/skyrim-multiplayer/skymp/issues/1338) (fechada como won't fix — mas ver §9.1: o evento chega por `onPapyrusEvent:OnHit`)

### Seção 9 — varredura do DeepWiki (09/08/2026)

**Código primário citado como `[DOC]` na §9.1** (lido via
`gh api repos/skyrim-multiplayer/skymp/contents/<caminho>`, branch `main`):

- `skymp5-server/cpp/server_guest_lib/ActionListener.cpp` — `OnHit` (L1006+),
  `OnSpellHit`/`OnWeaponHit` (L1215, L1256), `SendPapyrusOnHitEvent` (L1410-1425)
- `skymp5-server/cpp/server_guest_lib/MpForm.cpp:34-40` — `SendPapyrusEvent`
- `skymp5-server/cpp/server_guest_lib/gamemode_events/PapyrusEventEvent.{h,cpp}`
- `skymp5-server/cpp/server_guest_lib/gamemode_events/GameModeEvent.cpp` — `Fire`
- `skymp5-server/cpp/addon/ScampServerListener.cpp` — `OnMpApiEvent`
- `skymp5-server/cpp/addon/PapyrusUtils.h:14-49` — conversão Papyrus → JS
- Listagem de `gamemode_events/` — **não existe `HitEvent`**; o caminho é o Papyrus

**Páginas do DeepWiki lidas na §9** — [1.2 System Architecture](https://deepwiki.com/skyrim-multiplayer/skymp/1.2-system-architecture-overview) · [1.3 Repository Structure](https://deepwiki.com/skyrim-multiplayer/skymp/1.3-repository-structure) · [2.1 TypeScript Orchestration](https://deepwiki.com/skyrim-multiplayer/skymp/2.1-typescript-server-orchestration) · [2.2 ScampServer Addon](https://deepwiki.com/skyrim-multiplayer/skymp/2.2-scampserver-native-addon) · [2.3 PartOne e game loop](https://deepwiki.com/skyrim-multiplayer/skymp/2.3-partone-and-game-loop) · [2.4.1 MpActor/MpObjectReference](https://deepwiki.com/skyrim-multiplayer/skymp/2.4.1-mpactor-and-mpobjectreference) · [2.5.1 Database and Persistence](https://deepwiki.com/skyrim-multiplayer/skymp/2.5.1-database-and-persistence) · [3.1.1 JS API e Plugins](https://deepwiki.com/skyrim-multiplayer/skymp/3.1.1-javascript-api-and-plugin-system) · [3.1.2 Event System e Text Rendering](https://deepwiki.com/skyrim-multiplayer/skymp/3.1.2-event-system-and-text-rendering) · [3.2 Client Synchronization](https://deepwiki.com/skyrim-multiplayer/skymp/3.2-client-synchronization) · [3.2.2 WorldView e Entity Rendering](https://deepwiki.com/skyrim-multiplayer/skymp/3.2.2-worldview-and-entity-rendering) · [3.2.3 Input Capture e State Sync](https://deepwiki.com/skyrim-multiplayer/skymp/3.2.3-input-capture-and-state-synchronization) · [5 Gameplay Systems](https://deepwiki.com/skyrim-multiplayer/skymp/5-gameplay-systems) · [5.2 SweetPie PvP](https://deepwiki.com/skyrim-multiplayer/skymp/5.2-sweetpie-pvp-game-mode) · [5.3 Properties System](https://deepwiki.com/skyrim-multiplayer/skymp/5.3-properties-system) · [5.4 Command System](https://deepwiki.com/skyrim-multiplayer/skymp/5.4-command-system) · [7 Glossary](https://deepwiki.com/skyrim-multiplayer/skymp/7-glossary)
