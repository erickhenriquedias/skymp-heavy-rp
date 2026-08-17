# Matriz de transações de inventário

O que está coberto, o que não está, e **por que** cada linha existe.

**Atualizada em:** 16/08/2026 · Suíte principal — 895 testes, 203 suítes,
894 aprovados, 1 ignorado local, 0 falhas. O `pretest` de lifecycle executa
mais 5 testes antes dela.
Novos nesta rodada: 45 em `core/inventory.test.js`, 25 em
`trade-service.test.js`.

> Companheiro da [`INTERACTION_TEST_MATRIX.md`](INTERACTION_TEST_MATRIX.md).
> A regra é a mesma: uma linha "coberta" quer dizer que **existe um teste que
> reprova se a garantia sumir** — verificado por mutação, não por leitura.

---

## 0. A afirmação central

Os testes deste framework não perguntam *"a função devolveu `true`?"*. Perguntam:

> **Para todo `transfer_id`, a soma dos `delta` gravados no razão é zero.**

Uma checagem de `resultado.ok` passa em qualquer implementação que devolva
`true`. A soma só fecha se o item tiver mesmo saído de um lugar e entrado em
outro. Se alguém criar um caminho novo que move item sem gravar as duas pernas,
`conferirConservacao()` reprova sem saber que aquele caminho existe.

É a forma herdada do `conferirOuroFecha` da Fase 3, aplicada a item.

---

## 1. Mutações verificadas

Aplicadas ao código, executadas, revertidas. Não previstas — executadas.

| Mutação | Reprovou? | Testes que caíram |
|---|---|---|
| `session.version += 1` removido (mudança de oferta não derruba confirmação) | **sim** | 1 |
| Perna do dono `system` omitida do razão | **sim** | 1 |
| Replay de idempotência desligado | **sim** | 1 |
| Validação de `delta` removida de `applyStackDelta` | **sim** | 4 |
| Revalidação de distância removida do commit da troca | **sim** | 1 |
| Validação de item/quantidade ignorada no `exchange` | **sim** | 12 |

Base limpa antes e depois (`rc=0, fail=0`).

---

## 2. Transferência

| Caso | Coberto | Onde |
|---|---|---|
| Transferência simples entre personagens | sim | `core/inventory.test.js` |
| Merge de pilha (item que o destino já tem) | sim | idem — `applyStackDelta` soma |
| Split de pilha (mover parte) | sim | idem |
| Pilha zerada é apagada, não deixada em 0 | sim | idem, via `DELETE` |
| Duas quantidades do mesmo item no mesmo pedido são somadas | sim | *"soma quantidades do mesmo item"* |
| Origem igual ao destino é recusada | sim | `SAME_OWNER` |
| Dono de tipo sem adaptador falha fechado e por nome | sim | `NO_ADAPTER` |
| Container inexistente recusado **dentro** da transação | sim | `OWNER_NOT_FOUND` |
| Personagem offline (sem `actorId`) recebe item | sim | *"projeta no cliente só depois do commit"* |
| Estoque insuficiente não move nada | sim | |
| Erro de SQL não chega à tela do jogador | sim | |
| Cliente só é tocado depois do `commit` | sim | |

---

## 3. Dupe protection — o §9 do pedido, item a item

| Cenário | Antes | Agora | Onde |
|---|---|---|---|
| **Duplo clique** | parcial (só memória) | **sim** | `duplicate: true` devolve o mesmo `transferId`, o item sai uma vez |
| **Pacote repetido** | parcial | **sim** | idem — a chave sobrevive a restart, é do banco |
| **Reconexão** | parcial | parcial | `_syncedThisSession` continua por sessão; a fronteira do [ADR_003 §3](../technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md) não fechou |
| **Disconnect durante transferência** | não | **sim** | `trade-service.test.js`: *"quem saiu no meio cancela"* |
| **Cancelamento de trade** | não | **sim** | *"cancelar solta os dois lados"* |
| **Timeout de banco** | não | **sim** | `erroForcado` no INSERT do razão → rollback, nada movido, mensagem genérica |
| **Duas transferências simultâneas** | parcial (só ouro) | parcial | ver §6 |
| **Mesmo item vendido e trocado** | não | **sim** | *"quem vendeu o item entre a confirmação e o fechamento não doa nada"* |
| **Mesmo item craftado e dropado** | não | **sim** | *"craft sem ingrediente não entrega o resultado"* — o `FOR UPDATE` é a mesma proteção |

---

## 4. Segurança — o §19 do pedido

| Ataque | Coberto | Resposta |
|---|---|---|
| Quantidade negativa | sim | `INVALID_QUANTITY`, sem abrir transação |
| Quantidade zero | sim | `INVALID_QUANTITY` |
| `NaN` | sim | `INVALID_QUANTITY` / `INVALID_ITEM` |
| `Infinity` | sim | idem |
| Fracionário (`1.5`) | sim | idem |
| Overflow (`2e6` por item) | sim | teto por operação |
| Overflow de pilha (`INT` do MySQL) | sim | `Pilha cheia`, em vez de saturar em silêncio |
| FormID desconhecido | sim | `UNKNOWN_FORMID`, quando o `espm` **sabe** que não é item |
| FormID como string (`"0x10"`) | sim | `INVALID_ITEM` — a API não adivinha base |
| Container falso | sim | `OWNER_NOT_FOUND`, dentro da transação |
| Alvo falso (troca) | sim | `requestTrade` recusa ator sem personagem |
| Spoof de distância | sim | o servidor mede; o cliente não envia distância |
| Replay de trade | sim | `requestId = sessionId.vN`; `COMMITTING` bloqueia o segundo confirm |
| Replay de craft | sim | `requestId` sem `Date.now()` |
| `requestId` duplicado | sim | `duplicate: true`, não executa de novo |
| Injeção por nome de tabela | sim | `STACK_TABLES` é lista fechada; teste com `'characters; DROP TABLE x'` |
| Origem de `system` inventada | sim | lista fechada — `presente_de_natal` lança |

---

## 5. Troca — o §20 do pedido

| Caso | Coberto |
|---|---|
| Convite criado, indexado pelos dois lados | sim |
| Alvo inexistente / si mesmo / inválido | sim |
| Quem já está numa troca é recusado, dos dois lados | sim |
| Quem convidou não aceita o próprio convite | sim |
| Convite expira (45 s) | sim |
| Sessão expira (3 min) e libera os dois | sim |
| Ofertar mais do que se tem é recusado na hora | sim |
| Quantidade negativa remove da própria oferta, sem criar dívida | sim |
| Teto de tipos por lado | sim |
| **Mudança de oferta derruba as duas confirmações** | sim |
| Versão sobe a cada mudança | sim |
| Troca vazia não fecha | sim |
| Só o segundo confirm dispara o commit | sim |
| Commit move os dois lados e encerra a sessão | sim |
| Conservação (soma zero por `transfer_id`) | sim |
| Posse revalidada no commit | sim |
| Saída de um dos lados invalida | sim |
| Troca de personagem no mesmo ator invalida | sim |
| Afastar-se invalida (com `mp` medindo de verdade) | sim |
| Desconexão cancela e não deixa item órfão | sim |
| `sweep()` encerra tudo | sim |
| Interação some do menu de quem já negocia | sim |
| Auditoria da interação é `TRACE` | sim |

---

## 6. O que **não** está coberto, e por quê

### 6.1 Concorrência real

Os testes rodam contra um banco em memória de thread única. `FOR UPDATE`,
gap lock e deadlock **não são exercitados** — o mock não bloqueia.

O que os testes cobrem é que o código **pede** o lock (`SELECT … FOR UPDATE`
aparece na query) e que a ordem de aquisição é determinística (as operações são
ordenadas por `(chave do dono, base_id)`, o que torna o ciclo A→B/B→A
impossível). Que o MariaDB honre isso é premissa, não afirmação.

**Como fechar:** um teste de integração com banco real e duas conexões
concorrentes. `RUN_DB_CHECK=1 npm run test:systems` já é o lugar onde esse tipo
de teste vive neste projeto.

### 6.2 A migração v14

Fechado no código em 16/08/2026. `check-schema-drift.js` acompanha a
nulabilidade final declarada por `CREATE`, `ADD` e `MODIFY COLUMN`, consulta
`information_schema.COLUMNS.IS_NULLABLE` e reprova a diferença indicando a
migration de origem. Há regressão específica para o `character_id` da v14.

A consolidação de duplicatas da migração também não tem teste: ela roda uma vez,
contra dado que talvez não exista.

### 6.3 Reconciliação cliente → servidor

Continua unidirecional. Item pego do chão pelo jogador não vira linha no banco e
nenhum teste finge que vira. É a fronteira do
[ADR_003 §3](../technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md), aberta de
propósito.

### 6.4 Capacidade e peso

Não existem. Não há teste porque não há comportamento.

### 6.5 A barraca

`addItem`, `packStall` e `removeItem` passaram a mover o inventário **dentro** da
transação da barraca. `market-stalls-purchase.test.js` e
`market-stalls-service.test.js` continuam verdes e cobrem a compra, que já era
o caminho correto. `market-stalls-service.hardening.test.js` agora prova que
estoque, ledger e anúncio usam a mesma conexão antes do commit em
`addItem`/`removeItem`/`packStall`, e que uma falha no INSERT do anúncio pede
rollback depois da retirada da pilha.

### 6.6 Uma sessão real

Zero jogadores. 895 testes principais provam que o código faz o que os testes dizem;
não provam que o SkyMP se comporta como este projeto assume.

---

## 7. Como rodar

```bash
npm test
```

Só o framework de inventário e a troca:

```bash
node --test core/inventory.test.js trade-service.test.js
```
