# ADR 003 — Fonte de verdade do inventário: o banco, com uma fronteira nomeada

**Status:** aceito · **Data:** 13/08/2026 · **Contexto:** PROMPT 3 (Inventory Framework, Containers, Trade e Crafting)

> ADRs deste projeto vivem em `docs/technical/`, ao lado do [`ADR_001`](ADR_001_ONLINE_PROFILE_ID_IS_ACCOUNT_ID.md) e do [`ADR_002`](ADR_002_INTERACTION_FRAMEWORK.md).

---

## 1. Contexto

O §4 do pedido exige uma resposta única por categoria e proíbe duas autoridades
em conflito. A pergunta não é retórica: hoje existem **três** lugares que sabem
o que um personagem tem.

| Lugar | O que ele sabe | Quem escreve |
|---|---|---|
| `character_inventory` (MariaDB) | o que o servidor concorda que existe | `core/transaction-service` |
| Inventário nativo do Skyrim | o que o jogador vê e usa | o cliente, e `AddItem`/`RemoveItem` do servidor |
| Estoque em outros donos (`container_inventory`, `market_stall_items`) | item que saiu do personagem | três implementações independentes, até esta rodada |

A [`INVENTORY_TRADE_CRAFTING_AUDIT.md`](../research/INVENTORY_TRADE_CRAFTING_AUDIT.md)
mostrou que a terceira linha era o problema real: `core/transaction-service.js`
é bom, mas só sabe falar de **um** dono, então cada sistema que precisou do
outro lado escreveu o outro lado à mão, fora da transação.

---

## 2. Decisão

### 2.1 O banco é a fonte de verdade de **posse**

`character_inventory` e `container_inventory` são a resposta para *"quem tem o
quê"*. O inventário nativo é **projeção**: o servidor escreve nele depois do
commit e nunca lê dele para decidir nada.

Isso já era a regra escrita; o que muda é que agora ela vale para donos que não
são personagem.

### 2.2 Toda movimentação passa por `core/inventory.js`

Uma API, com dono tipado dos dois lados:

```js
inventory.transfer({ from, to, items, reason, module, requestId })
inventory.exchange({ legs, reason, module, requestId })   // várias pernas, uma transação
```

Nenhum módulo de gameplay escreve em tabela de inventário. `core/inventory.js`
não reimplementa nada: ele usa as primitivas `tx.*` do
`core/transaction-service`, que continua sendo o único lugar que sabe travar
linha, recusar estoque insuficiente e gravar razão.

### 2.3 O razão nomeia os dois lados

`inventory_transactions` ganhou `owner_type`, `owner_ref`, `counterparty_type`,
`counterparty_ref` e `transfer_id` (`migration-v14`). Consequência verificável:
**para todo `transfer_id`, a soma dos `delta` é zero.**

É o que torna respondível a pergunta que a staff vai fazer no primeiro caso de
duplicação — *"este item apareceu de onde?"* — e que antes não tinha resposta,
porque metade dos movimentos só gravava a perna do personagem.

### 2.4 Criar e destruir item é um dono, não uma exceção

`system` é um tipo de dono sem armazenamento, com uma lista fechada de origens
(`craft`, `consume`, `gather`, `staff`, `destroy`, `seed`). Item que nasce vem
de `system`; item que morre vai para `system`, e as duas coisas deixam linha.

Isso não concede poder novo — `transactionService.giveItem` já criava item. O
que muda é que o poder fica **escrito na assinatura** e a pergunta *"que
caminhos criam item neste servidor?"* passa a ser respondível por leitura.

### 2.5 Pilha é o padrão; instância não existe ainda

O modelo continua `(dono, base_id, count)`. Não há tabela de instância, e o §5
do pedido pede exatamente isso (*"não transformar todo item em UUID se isso for
desnecessário"*). O desenho da instância está em
[`INVENTORY_FRAMEWORK.md`](../framework/INVENTORY_FRAMEWORK.md) §4; a tabela
nasce com o primeiro consumidor, não antes.

### 2.6 SkyUI e itens customizados não mudam a autoridade

SkyUI será apresentação. O patch nativo planejado para criar/aplicar itens
customizados server-side será um adapter de projeção: recebe definições e
instâncias já validadas pelo domínio, aplica no Skyrim e reporta resultado. Ele
não concede ao client autoridade para criar item, escolher metadata ou confirmar
persistência.

Stacks fungíveis continuam `(owner, base_id, count)`. UUID de instância entra
somente para item que realmente possui identidade — encantamento customizado,
durabilidade, nome próprio, proveniência, carga, poison, morph ou outra metadata
persistente. O contrato de projeção terá versão/capabilities para coexistir com
o caminho vanilla durante a implantação do patch.

---

## 3. A fronteira que esta decisão **não** fecha

Esta é a parte honesta do ADR, e ela precisa estar aqui e não numa nota de
rodapé.

**Na direção cliente → servidor, o cliente continua sendo autoridade de fato
sobre tudo que o servidor nunca soube.** Item pego do chão, saque de NPC
vanilla, recompensa de quest: nada disso passa por `core/inventory.js`, nada
disso vira linha em `character_inventory`, e o `syncInventoryToClient` não tem
como descobrir — ele só *soma* o que o banco conhece, nunca compara.

Fechar isso exige duas coisas que não existem:

1. Ler o inventário nativo — `mp.get(id, 'inventory')` segue marcada **[DOC]**
   em `types/mp.d.ts`, nunca exercitada por este projeto.
2. Uma **política de divergência**: o que fazer quando o cliente tem o que o
   banco não conhece. Apagar do cliente pune quem pegou uma flecha do chão;
   aceitar no banco transforma o cliente em fonte de verdade por outra porta.

A segunda é decisão de jogo, não de engenharia, e depende de uma sessão real
para saber o tamanho do problema. Está registrada como aberta em vez de
resolvida por adivinhação.

**Enquanto isso, o desenho vale para o que passa pelo servidor** — que é todo o
patrimônio que qualquer sistema de Heavy RP move: troca, barraca, craft, baú,
confisco, morte.

---

## 4. Alternativas consideradas

### 4.1 Tabela genérica `inventory_owner` + `inventory_item`

O §7 do pedido sugere esta forma. **Rejeitada como migração agora**, e o §7
também diz por quê: *"não mudar banco sem necessidade"*.

`character_inventory` é lida no login de todo jogador e escrita em toda
transação; `container_inventory` idem. Trocá-las por uma tabela genérica é uma
migração de dados vivos para ganhar uma indireção que o código já obtém pelo
adaptador. E `market_stall_items` **não caberia mesmo assim**: ela carrega
preço, rótulo e status por anúncio — é oferta, não pilha —, e forçá-la na
tabela genérica apagaria a diferença.

O que a decisão adota é a **metade que dá o ganho**: o dono genérico existe no
código (`core/inventory-owner.js`) e no razão (`migration-v14`), e cada tipo
diz onde mora o estoque dele por um adaptador. O dia em que uma tabela genérica
valer a pena, ela é mais um adaptador.

### 4.2 Manter cada sistema escrevendo o próprio lado, com compensação

É o que a barraca fazia: remover do inventário numa transação, listar noutra, e
devolver no `catch`. **Rejeitada** porque compensação só cobre falha que o
processo chega a observar — um servidor que morre entre os dois commits deixa o
item destruído, sem nada ligando as duas metades.

### 4.3 Instância (UUID) para todo item

**Rejeitada.** Multiplica linhas por `count` (400 flechas = 400 linhas), e o
Skyrim nativo não tem o conceito: `AddItem(baseId, count)` é a única API de
entrega, então uma instância no banco não teria como ser projetada no cliente.
Nenhum sistema atual lê durabilidade, qualidade ou proveniência.

### 4.4 Idempotência de transferência em memória

É o que o Interaction Framework faz para duplo clique, e ali é a escolha certa.
**Rejeitada aqui** pelo motivo que aquele mesmo documento dá: a idempotência que
protege item precisa sobreviver a restart, e o `UNIQUE (idempotency_key)` do
razão já a dá. As duas camadas continuam existindo e protegendo coisas
diferentes.

---

## 5. Consequências

### Boas

- Movimento entre donos diferentes é atômico pela primeira vez. Três caminhos
  que podiam destruir item deixaram de poder (`housing.depositItem`,
  `market-stalls.addItem`, `market-stalls.packStall`/`removeItem`).
- O razão fecha. A conservação é verificável por query e é o que os testes
  afirmam, em vez de "a função devolveu `true`".
- Um dono novo entra por adaptador, sem tocar no core — mesma inversão do
  Interaction Framework.
- A validação de entrada (`NaN`, negativo, estouro, FormID desconhecido) existe
  **uma vez**, e não três vezes fora do arquivo que é a autoridade.

### Custos

- Mais um conceito: além de `transaction-service`, existe `inventory`. A regra
  para saber qual usar está no `INVENTORY_FRAMEWORK.md` §3, e é curta: um dono
  só → `transaction-service`; dois donos → `inventory`.
- O razão cresceu: duas linhas por item movido em vez de uma. Para um servidor
  de Heavy RP isso é barato; para um de 500 jogadores fazendo craft em massa,
  seria a primeira coisa a medir.
- `migration-v14` altera nulabilidade de `character_id`, e
  `check-schema-drift.js` **não reconhece `MODIFY COLUMN`** — um banco que pulou
  esta migração não aparece como divergente. Está anotado na própria migração.

### Riscos aceitos

- **Quatro dos sete tipos de dono não têm adaptador** (`property`, `faction`,
  `corpse`, `market`). Falham fechado e por nome. Escrevê-los agora seria
  escrever contra tabelas que não existem, pelo mesmo critério que deixou seis
  dos sete resolvedores de alvo por escrever.
- **Capacidade e peso não existem.** O contrato do adaptador tem o lugar
  (`capacity`), nenhum adaptador o implementa, e nenhuma coluna o suporta.
  Declarado ausente, não simulado.
- **Nada disto rodou numa sessão real.** 716 testes verdes e zero jogadores — a
  mesma frase que o `ADR_002` e o `INTERACTION_FRAMEWORK.md` carregam, pela
  mesma razão.

---

## 6. Como saber que esta decisão foi errada

- Se um sistema novo precisar escrever em tabela de inventário direto para
  fazer algo razoável, a API está estreita demais e o lugar de corrigir é ela,
  não o sistema.
- Se a soma dos `delta` por `transfer_id` deixar de fechar em produção, existe
  um caminho de escrita fora do framework — e a query que descobre isso é a
  mesma que os testes fazem.
- Se `exchange` aparecer no orçamento de frame por causa das duas linhas de
  razão por item, medir antes de otimizar; o candidato é gravar uma linha por
  transferência com as pernas em JSON, e isso custa a query de extrato.
- Se a política de divergência do §3 continuar sem dono depois da primeira
  sessão real com jogadores pegando item do chão, ela deixou de ser fronteira
  conhecida e virou dívida.

---

## 7. Referências

- [`docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md`](../research/INVENTORY_TRADE_CRAFTING_AUDIT.md) — a auditoria que precedeu esta decisão
- [`docs/framework/INVENTORY_FRAMEWORK.md`](../framework/INVENTORY_FRAMEWORK.md) — o contrato de uso
- [`docs/gameplay/TRADE_SYSTEM.md`](../gameplay/TRADE_SYSTEM.md) · [`docs/gameplay/CRAFTING_SYSTEM.md`](../gameplay/CRAFTING_SYSTEM.md)
- [`docs/testing/INVENTORY_TRANSACTION_MATRIX.md`](../testing/INVENTORY_TRANSACTION_MATRIX.md) — o que está coberto e o que não está
- [`ADR_002`](ADR_002_INTERACTION_FRAMEWORK.md) §4 — por que não há Service Locator; a mesma inversão vale para adaptadores
- [`PARKED_SERVICES_DECISION.md`](PARKED_SERVICES_DECISION.md) §2, §7.2, §7.3 — as duas vezes anteriores em que este defeito foi apagado
