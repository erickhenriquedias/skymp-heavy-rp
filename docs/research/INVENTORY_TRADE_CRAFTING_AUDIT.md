# Auditoria: inventário, containers, trade e crafting

**Data:** 13/08/2026 · **Escopo:** PROMPT 3 · **Estado do servidor:** nada disto rodou numa sessão real.

> **Atualização de 16/08/2026:** os achados desta auditoria permanecem como
> registro do estado encontrado. A fonte de verdade foi consolidada pelo
> `core/inventory.js`; barracas ganharam testes de atomicidade/rollback, e o
> drift checker agora reconhece a nulabilidade alterada por `MODIFY COLUMN`.

Esta auditoria precede qualquer mudança de código, pela mesma regra que a
[`CORE_FRAMEWORK_AUDIT.md`](CORE_FRAMEWORK_AUDIT.md) seguiu: o que for corrigido
depois tem que apontar para um parágrafo daqui.

Arquivos lidos por inteiro: `core/transaction-service.js`, `inventory-service.js`,
`housing-service.js`, `crafting-service.js`, `trade-service.js`,
`market-stalls-service.js` (trechos de item e ouro), `packages/database/schema.sql`,
`migration-v4-market-stalls.sql`, `migration-v13-market-stall-idempotency.sql`,
`core/interaction-registry.js`, `core/interaction-targets.js`, `core/module-registry.js`.

---

## 0. Resumo executivo

O `core/transaction-service.js` é bom e faz o que promete: `BEGIN`,
`SELECT … FOR UPDATE`, ledger, `idempotency_key`. **O problema não é ele — é que
ele só sabe falar sobre um personagem.**

Toda vez que um item precisou sair do personagem e ir para outro lugar
(container, barraca, receita), quem precisou disso escreveu o outro lado à mão,
fora da transação. São três implementações independentes de "guardar item em
algum lugar que não é um personagem", e as três têm a **mesma forma de defeito**
que já foi apagada duas vezes neste projeto: o `economy-service.transfer`
(`removeGold` seguido de `addGold`, §2 do [`PARKED_SERVICES_DECISION.md`](../technical/PARKED_SERVICES_DECISION.md))
e o `craftItem` pré-Fase 3 (§7.2 do mesmo).

| # | Achado | Onde | Gravidade |
|---|---|---|---|
| 1 | O ledger **não consegue** representar dono que não seja personagem | `schema.sql:371` | Alta — item some da contabilidade |
| 2 | Depósito em container destrói item se a segunda query falhar | `housing-service.js:121‑135` | Alta (PARKED) |
| 3 | Listar item em barraca é compensação, não atomicidade | `market-stalls-service.js:574‑616` | Alta |
| 4 | `packStall` devolve N itens em N transações independentes | `market-stalls-service.js:509‑511` | Alta |
| 5 | A chave de idempotência do craft inclui `Date.now()` — nunca deduplica | `crafting-service.js:91` | Alta (PARKED) |
| 6 | `tx.applyInventoryDelta` aceita `delta` NaN/0 e `baseId` não numérico | `core/transaction-service.js:65` | Média |
| 7 | Checagem de idempotência fora da transação (TOCTOU) | `core/transaction-service.js:161,207,262` | Média |
| 8 | `container_inventory` sem `UNIQUE(dono, base_id)` — `character_inventory` tem, desde a v7 | `schema.sql:102` | Média |
| 9 | `transfer()` move **um** `baseId` — trade precisa de N | `core/transaction-service.js:253` | Média |
| 10 | Reconciliação de login só soma; nunca reflete o que o cliente tem a mais | `inventory-service.js:32‑81` | Média |
| 11 | Crafting não valida estação nem perk, e o cabeçalho diz que valida | `crafting-service.js:1‑10, 70‑154` | Média (PARKED) |
| 12 | `trade-service` não tem transferência, timeout, limpeza em disconnect nem máquina de estados | `trade-service.js` inteiro | Alta (PARKED) |
| 13 | Não existe capacidade, peso, item equipado nem instância | schema inteiro | Desenho |

---

## 1. Tabela atual e formato do item

### 1.1 O que existe

```sql
character_inventory ( id PK, character_id FK, base_id INT, count INT )
container_inventory ( id PK, container_id FK, base_id INT, count INT )
market_stall_items  ( id PK, stall_id FK, base_id INT, count INT,
                      price INT, label VARCHAR, status ENUM-ish )
crafting_recipes    ( id, name, station_type, result_base_id, result_count, requires_perk )
crafting_ingredients( id, recipe_id FK, base_id, count )
inventory_transactions ( transaction_id CHAR(36) PK, character_id FK NOT NULL,
                         base_id, delta, reason, module, idempotency_key UNIQUE, status )
gold_transactions   ( … idem, sem base_id )
```

**O modelo de item é `(dono, base_id, count)` — pilha pura.** Não há instância,
não há durabilidade, não há dono anterior, não há "roubado". `base_id` é o FormID
nativo do Skyrim **em decimal** (`schema.sql:85`), enquanto `containers.object_id`
e `market_stalls.cell_id` guardam `formDesc` (`"0x3003A:Skyrim.esm"`). São dois
vocabulários de identificação de coisa do jogo dentro do mesmo schema — não é um
defeito, mas é uma armadilha para quem escrever a próxima query.

### 1.2 O que **não** existe, e ninguém finge que existe

Item equipado, peso, capacidade, container por tipo (mochila × baú), item com
identidade própria, expiração, proveniência. Nada disso tem coluna, código ou
consumidor. Isto é relevante para o §5 do pedido: a resposta correta hoje **não é
transformar tudo em UUID**, e a §5 desta auditoria explica com o que se paga.

---

## 2. Achado 1 — o ledger não consegue nomear um dono que não seja personagem

```sql
CREATE TABLE inventory_transactions (
  character_id INT NOT NULL,                       -- ← schema.sql:373
  CONSTRAINT fk_inv_tx_char FOREIGN KEY (character_id) REFERENCES characters (id)
)
```

`character_id` é `NOT NULL` com FK. Consequência direta e verificável:

- **Depósito em container** grava a saída do personagem (`removeItem`) e **nada**
  sobre a entrada no baú. O item existe em `container_inventory` sem nenhuma
  linha que explique como chegou lá.
- **Item listado em barraca** grava `stall_list_item` (delta negativo no
  personagem) e nada sobre o estoque da barraca.
- **Craft** grava `craft_consume` e `craft_result` — os dois no personagem —, o
  que por acaso funciona, porque o outro lado do craft é o nada.

Em contabilidade isso é um razão que só registra débito. A soma dos deltas de um
personagem bate com o inventário dele; a soma de todos os deltas **não bate com
nada**, porque metade dos movimentos não tem contrapartida registrada.

Isto é o que impede a pergunta que a staff vai fazer no primeiro caso de
duplicação: *"este item apareceu de onde?"*.

---

## 3. Achado 2 — depósito em container pode destruir item

`housing-service.js:121‑135` (PARKED):

```js
const removed = await inventoryService.removeItem(actorId, characterId, baseId, count);
if (!removed) { … return false; }

const exist = await db.query('SELECT count FROM container_inventory WHERE …');
if (exist.length > 0) {
  await db.query('UPDATE container_inventory SET count = count + ? …');
} else {
  await db.query('INSERT INTO container_inventory …');
}
```

`removeItem` **abre e commita a própria transação**. As duas queries seguintes
são independentes, sem `BEGIN`, sem lock. Se qualquer uma falhar — pool
esgotado, deadlock, servidor caindo — o item já saiu do personagem e não entrou
no baú. **Sumiu.**

É literalmente a forma do `economy-service.transfer` que foi apagado em
06/08/2026, e a forma do `craftItem` que foi corrigida na Fase 3. Terceira
ocorrência do mesmo padrão, agora em container.

O `openContainers` (linha 8) também merece nota: é lock de sessão em memória,
chaveado por `objectId`, com liberação só por `closeContainer`. Ninguém chama
`closeContainer` no disconnect — grep confirma zero chamadores fora do próprio
arquivo. Um jogador que cai com o baú aberto o deixa **trancado para sempre**,
até o restart.

---

## 4. Achados 3 e 4 — barraca: compensação em vez de atomicidade

### 4.1 Listar (`addItem`, linhas 574‑616)

```js
const removed = await inventory.removeItem(…);   // transação 1, já commitada
…
await conn.beginTransaction();                    // transação 2
await conn.query('INSERT INTO market_stall_items …');
await conn.commit();
// catch: await inventory.giveItem(…)             // transação 3, compensatória
```

O comentário na linha 572 é honesto sobre a ordem (`Remover item do inventario
ANTES da transacao de barraca`), mas a compensação só cobre **falha observada
por este processo**. Se o servidor morrer entre o commit da transação 1 e o da
transação 2, o item saiu do inventário e nunca virou anúncio. Não há
reconciliação que descubra isso: nada liga a linha do ledger
(`reason='stall_list_item'`) à ausência de uma linha em `market_stall_items`.

### 4.2 Recolher (`packStall`, linhas 509‑511)

```js
for (const item of items) {
  await inventory.giveItem(actorId, character.characterId, item.base_id, item.count, 'stall_pack_return', MODULE);
}
```

A transação que marcou os itens como `removed` **já commitou** (linha 496). Este
laço são N transações independentes. Uma barraca com dez itens e uma falha no
quinto devolve quatro e perde seis, com os dez já marcados `removed` — irreversível
por qualquer caminho automático.

O comentário nas linhas 506‑508 explica corretamente **por que** a devolução vem
depois do commit (evitar a janela de reivindicação dupla) e não percebe que
trocou uma janela de duplicação por uma janela de perda.

### 4.3 O que a barraca faz certo, e por que importa

`buyItem` (718‑860) é o melhor caminho de item deste código e deve ser o modelo:
uma transação, `findPurchaseReplay` com `FOR UPDATE` **dentro** dela, primitivas
`tx.*`, ledger nas duas pernas de ouro, `applyToClient` depois do commit. A
diferença entre `buyItem` e `addItem` no mesmo arquivo é a medida exata da dívida.

---

## 5. Achado 5 — a idempotência do craft não deduplica nada

`crafting-service.js:89‑91`:

```js
// 3. Uma chave por (personagem, receita, instante) — se o comando for
// reenviado, o ledger recusa a segunda gravacao em vez de craftar duas vezes.
const idempotencyKey = `craft_${characterId}_${recipeId}_${Date.now()}`;
```

O comentário está errado, e o motivo é o `Date.now()`. Dois `/craft` seguidos
produzem **duas chaves diferentes**, o `UNIQUE (idempotency_key)` não é violado,
e o craft acontece duas vezes. A chave é única por chamada — que é o oposto do
que uma chave de idempotência é.

Uma chave de idempotência precisa vir de **quem pede** (o `requestId` do cliente,
como `market-stalls.normalizePurchaseRequestId` faz) ou de um estado estável
(`recipeId + janela`). Nunca do relógio de quem executa.

Isso não causa duplicação de item hoje — os ingredientes são consumidos de
verdade nas duas vezes, então é craft duplo legítimo, não item do nada. É
gravidade alta mesmo assim porque o comentário **afirma uma proteção que não
existe**, e o próximo a ler vai construir em cima dela.

---

## 6. Achado 6 — a primitiva exportada valida menos que o wrapper

`giveItem`/`removeItem` fazem `if (count <= 0) throw`. `tx.applyInventoryDelta`
(`core/transaction-service.js:65`), que é a exportada para quem precisa
participar da transação do chamador, **não valida nada**:

| entrada | o que acontece |
|---|---|
| `delta = NaN` | `NaN > 0` é `false` → cai no ramo de remoção → `Math.abs(NaN)` = `NaN` → `currentCount < NaN` é `false` → `newCount = NaN` → `UPDATE … SET count = NaN` |
| `delta = 0` | cai no ramo de remoção, remove zero, reescreve o mesmo valor e grava uma linha de ledger com `delta = 0` |
| `delta = 1e308` | passa; o `INT` do MySQL trunca ou erra dependendo do modo estrito |
| `baseId = "abc"` | o caminho de erro faz `baseId.toString(16)` — `TypeError` dentro do `catch`, mascarando a causa real |

Os dois chamadores atuais (`crafting-service`, `market-stalls-service`) passam
valores já validados por acaso, cada um com a própria função (`parseFormId`,
`parsePositiveInt`, `core/espm.pareceItem`). A validação existe três vezes, fora
do arquivo que é a autoridade.

---

## 7. Achado 7 — a checagem de idempotência está fora da transação

```js
if (idempotencyKey) {
  const existing = await db.query('SELECT … WHERE idempotency_key = ?', [k]);  // conexão A
  if (existing.length > 0) return true;
}
const conn = await db.getConnection();                                          // conexão B
await conn.beginTransaction();
```

Duas chamadas concorrentes com a mesma chave leem `0` nas duas, ambas seguem, e
o `UNIQUE` mata a segunda no `INSERT` do ledger → `rollback` → **`return false`**.

O item não duplica (o `UNIQUE` segura), mas o valor de retorno mente: uma
duplicata de uma operação que deu certo devolve `false`, e o chamador trata isso
como *"não tinha o item"*. Em `market-stalls.addItem` isso dispararia a
compensação (`giveItem`) para uma operação que já tinha sido aplicada — o único
caminho de duplicação real que esta auditoria encontrou.

A forma certa já existe no mesmo repositório: `findPurchaseReplay` faz o
`SELECT … FOR UPDATE` **dentro** da transação (`market-stalls-service.js:122‑126`).

---

## 8. Achado 8 — o baú não tem a chave que o personagem tem

`schema.sql` cria as duas tabelas só com `PRIMARY KEY (id)` e o índice da FK.
Para `character_inventory` isso é enganoso: a
[`migration-v7-indexes.sql`](../../skymp/packages/database/migration-v7-indexes.sql):33
adiciona `UNIQUE (character_id, base_id)`, com o comentário certo pelo motivo
certo — *"protege contra duas linhas para o mesmo item no mesmo personagem, que
e o estado que o `FOR UPDATE` do transaction-service assume nao existir"*.

**`container_inventory` ficou de fora daquela rodada**, e o invariante lá é
mantido só por convenção do código.

Consequências de uma duplicata em `container_inventory`, se ela aparecer por
qualquer caminho (import manual, um segundo escritor):

- a leitura com `FOR UPDATE` pega `rows[0].count` e ignora as outras linhas;
- o estoque restante fica invisível para o servidor e vivo na tabela.

Isso não é urgente hoje — nada escreve em `container_inventory` além do
`housing-service`, que está PARKED — mas passa a ter API a partir desta rodada,
e a chave é o que impede que a próxima escrita dependa de sorte.

> **Correção.** A primeira versão desta auditoria afirmava que **as duas**
> tabelas estavam sem a chave. Estava errado: a `v7` cobre `character_inventory`
> desde 05/08/2026. O erro veio de ler `schema.sql` sem cruzar com as
> migrations, que é exatamente o que o `check-schema-drift.js` existe para
> impedir — e ele teria mostrado, porque lê as duas coisas juntas.

---

## 9. Achado 9 — `transfer()` move um item por vez

```js
async function transfer({ … baseId, itemCount, goldAmount, … })
```

Uma perna de item e uma de ouro, entre dois personagens. Uma troca de Heavy RP é
*"minha espada e 3 poções pelas suas 200 moedas e o mapa"* — quatro pernas de
item em direções opostas, numa transação. Chamar `transfer()` quatro vezes são
quatro transações, e cai no defeito do §3.

---

## 10. Achado 10 — a reconciliação de login é unidirecional

`inventory-service.syncInventoryToClient` lê o banco e chama `AddItem` para o que
ainda não foi entregue **nesta sessão**. Ela nunca:

- remove do cliente o que o cliente tem e o banco não conhece;
- compara contagens (se o banco diz 3 e o cliente tem 5, ninguém percebe);
- roda de novo depois do login (chamador único: `whitelist.js:220`).

Isso torna o §4 do pedido — *"Native Skyrim inventory → projection"* — verdadeiro
só na direção banco → cliente. Na outra direção o cliente é autoridade de fato
sobre tudo que o servidor nunca soube: item pego do chão, saque de NPC vanilla,
recompensa de quest. O `jobs-service` (PARKED) explora exatamente essa brecha, e
o §7.3 do `PARKED_SERVICES_DECISION.md` já registra o diagnóstico.

**Isto não é corrigível pelo lado do servidor sozinho** e a auditoria não propõe
corrigir agora: exige ler o inventário nativo (`mp.get(id, 'inventory')`, ainda
marcada `[DOC]` em `types/mp.d.ts` — nunca exercitada) e decidir uma política de
divergência. Fica registrado como a fronteira real da autoridade, e o
[`ADR_003`](../technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md) a nomeia em vez de
fingir que ela não existe.

---

## 11. Achado 11 — o crafting não faz o que o cabeçalho dele diz

```js
 * - O servidor valida ingredientes, station proximity e perks.
```

`craftItem` valida **ingredientes** (indiretamente, pelo `FOR UPDATE` do
`applyInventoryDelta`). Não valida estação: `station_type` é lido em
`listRecipes` e o `craftItem` nem carrega a estação do jogador. Não valida perk:
`requires_perk` é selecionado em `listRecipes` e nunca comparado com nada.

Ou seja: `/craft <id>` funciona de qualquer lugar do mapa, sem estar perto de
forja nenhuma, sem perk nenhum. Como o serviço está PARKED, ninguém sentiu.

---

## 12. Achado 12 — o trade-service é um convite sem troca

O arquivo inteiro (90 linhas) negocia convite e guarda `{initiatorId, targetId,
status}` num `Map`. O que falta, item a item do §10 do pedido:

| Precisa | Existe? |
|---|---|
| Adicionar item à oferta | não |
| Confirmação dos dois lados | não |
| Invalidar confirmação quando a oferta muda | não |
| Revalidação no commit | não |
| Transação | não |
| Timeout | não |
| Limpeza no disconnect | **não** — `activeTrades` nunca é limpo fora de `cancelTrade` |
| Distância | não |

Além disso `cancelTrade` remove por `session.initiatorId`, o que está certo, mas
`getTradeSession` varre o `Map` inteiro a cada chamada — O(n) por operação, com n
= trocas ativas. Irrelevante hoje, registrado porque a estrutura certa é dois
índices.

Nota de escopo: o §6 do `PARKED_SERVICES_DECISION.md` aponta a janela de troca do
Red House como referência de **casos a cobrir**, não de código a portar, e lista
três decisões que precisam estar fechadas antes de abrir aquele repositório.
Nenhuma linha foi portada nesta rodada.

---

## 13. Achado 13 — o que o desenho não tem, e o que fazer com isso

Capacidade, peso, item equipado, instância, metadata. Nenhum tem coluna nem
consumidor.

O §5 do pedido é explícito: *"Não transformar todo item em UUID se isso for
desnecessário"*. Esta auditoria concorda e vai além — **transformar seria caro e
errado agora**:

- `character_inventory` é lida no login de todo jogador e escrita em toda
  transação. Trocar pilha por instância multiplica linhas por `count`: um
  jogador com 400 flechas vira 400 linhas.
- O Skyrim nativo **não tem** o conceito. `AddItem(baseId, count)` é a única API
  de entrega. Uma instância no banco não tem como ser projetada no cliente hoje.
- Nenhum sistema atual — barraca, governança, craft, morte — lê durabilidade,
  qualidade ou proveniência.

A decisão registrada no [`INVENTORY_FRAMEWORK.md`](../framework/INVENTORY_FRAMEWORK.md)
§4 é: **pilha é o padrão, instância é opt-in por definição de item, e nenhuma
definição opta hoje.** O ponto de extensão fica nomeado; a tabela não é criada
antes do primeiro consumidor, pelo mesmo critério que deixou seis dos sete
resolvedores de alvo por escrever.

---

## 14. Dupe: o que foi testado de verdade

O §9 do pedido lista nove cenários. Estado **antes** desta rodada:

| Cenário | Coberto antes? | Onde |
|---|---|---|
| duplo clique | parcial | `interaction-service` deduplica por `requestId` em memória |
| pacote repetido | parcial | idem, e `idempotency_key` no ledger |
| reconexão | parcial | `_syncedThisSession` — mas por sessão, não por estado |
| disconnect no meio da transferência | **não** | não há transferência |
| cancelamento de trade | **não** | não há trade |
| timeout de banco | **não** | nenhum teste força falha de conexão |
| duas transferências simultâneas | parcial | `transaction-service.test.js` cobre `FOR UPDATE` de ouro |
| mesmo item vendido e trocado | **não** | |
| mesmo item craftado e dropado | **não** | |

A matriz completa, com o estado **depois**, está em
[`INVENTORY_TRANSACTION_MATRIX.md`](../testing/INVENTORY_TRANSACTION_MATRIX.md).

---

## 15. Migrations: estado

O runner aplica `schema.sql` + migrations versionadas sob lock e ledger de
checksum. `check-schema-drift.js` faz a verificação independente contra
`information_schema`: tabelas, colunas, índices e, desde 16/08/2026,
nulabilidade final de `CREATE`, `ADD` e `MODIFY COLUMN`.

---

## 16. O que esta auditoria conclui

1. O caminho único para item existe (`transaction-service`) e **é bom para um
   personagem**. O que falta é a camada acima dele: um dono genérico.
2. Três sistemas escreveram o "outro lado" à mão. Não é coincidência — é o que
   acontece quando a API só sabe falar de um lado.
3. A correção não é reescrever o `transaction-service`. É pôr **uma** API de
   transferência acima dele, com dono tipado dos dois lados, e fazer os três
   sistemas passarem por ela.
4. Nenhum sistema novo de gameplay deve ser construído antes disso, senão vira o
   quarto.

O desenho está em [`INVENTORY_FRAMEWORK.md`](../framework/INVENTORY_FRAMEWORK.md);
a decisão de autoridade em [`ADR_003`](../technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md).
