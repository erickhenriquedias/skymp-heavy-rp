# Sistema de Módulos

Arquivo: [`core/module-registry.js`](../../skymp/gamemode/core/module-registry.js) · Testes: [`core/module-registry.test.js`](../../skymp/gamemode/core/module-registry.test.js) (19 casos)

Um módulo é uma unidade que pode ser ligada, desligada e substituída sem que o resto do servidor saiba. Ele declara o que precisa; o registry decide se e quando ele sobe.

---

## 1. O descritor

```js
moduleRegistry.register({
  id: 'market-stalls',                          // único
  enabledBy: 'ENABLE_MARKET_STALLS_SERVICE',    // env var; só 'true' liga
  phase: 'core' | 'lab' | 'parked',
  version: '1.1.0',

  dependencies: ['governance', 'interaction'],  // sem elas, não sobe
  optionalDependencies: ['economy-regional'],   // consulta se existir

  commands: marketStalls.commandDefs(),         // registrados/removidos sozinhos

  initialize: async () => { ... },
  shutdown: async () => { ... },
  healthCheck: () => boolean
});
```

`enabledBy` é obrigatório e a comparação é `=== 'true'`. Ausente conta como desligado — e é assim que todo módulo `lab` nasce.

---

## 2. Ciclo de vida

```
REGISTERED ──► DISABLED           (env flag ausente ou ≠ 'true')
     │
     ├───────► FAILED             (dependência ausente, ou initialize lançou)
     │
     └───────► INITIALIZING ──► READY ──► RUNNING
                                             │
                                             ▼
                                         STOPPING ──► STOPPED
```

`getState(id)` devolve o estado; `isEnabled(id)` continua respondendo só "está rodando?".

**A distinção que importa é `DISABLED` × `FAILED`.** Até 13/08/2026 o estado era um `Set`: dois estados para cinco situações, e as duas que se confundiam eram justamente essas. `isEnabled()` responde `false` para as duas, e só uma é incidente — um servidor com `governance` quebrado no boot parecia, para qualquer código e para o `list()`, um servidor que simplesmente não quis governança.

`FAILED` também é o estado que o Interaction Framework precisa: um módulo que registrou interações e depois falhou deixaria ações no menu apontando para um serviço que nunca inicializou. Por isso o boot limpa o registro de interações de quem falha.

---

## 3. Dependências

### Ordenação topológica

`bootAll()` ordena antes de subir. Toda dependência — obrigatória ou opcional — vem antes de quem depende dela, **independentemente da ordem de registro**.

Isto conserta um bug latente. Antes, o boot percorria os módulos na ordem de inserção e só considerava satisfeita a dependência já inicializada numa iteração anterior. Funcionava porque `phase0-basic.js` registra `governance` antes de `market-stalls`; mover aquele bloco vinte linhas para cima desligava o módulo com

```
market-stalls: FALHOU — dependências não ativas: governance
```

— uma mensagem correta sobre um estado que não deveria existir. Era dependência invisível na camada de módulo, com a agravante de o modo de falha ser silencioso: o log dizia a verdade e ninguém lia.

### Obrigatória × opcional

|  | Obrigatória | Opcional |
|---|---|---|
| Ausente ou desligada | O módulo **falha** | O módulo sobe normalmente |
| Presente | Sobe antes | Sobe antes |
| Declara o quê | "não funciono sem" | "uso se existir" |

`optionalDependencies` existe por um caso real: `governance` consulta `economy-regional` se ele estiver ligado, e resolvia isso com `moduleRegistry.isEnabled()` + `require` dentro de um `try`, no meio de uma função de domínio. Declarar tira a decisão de lá.

O log de boot mostra as opcionais inativas:

```
[module-registry] [LAB] governance@1.1.0: ATIVO (18 comandos registrados, opcionais inativas: economy-regional)
```

### Ciclo

Ciclo é erro de quem programa, não condição de runtime. Os módulos envolvidos são **nomeados** e ficam de fora do boot; o servidor não trava, o resto sobe, e a ordem não vira sorte.

```
[module-registry] CICLO de dependência: a → b → a. Módulos envolvidos ficam de fora do boot.
```

---

## 4. O que o registry faz sozinho

| No boot | No shutdown |
|---|---|
| Ordena por dependência | Ordem **inversa** |
| Checa a env flag | — |
| Checa dependências obrigatórias | — |
| Chama `initialize()` | Chama `shutdown()` |
| Registra `commands[]` no `command-registry` | Remove `commands[]` |
| — | Remove as interações do módulo |
| Remove interações de quem **falhou** no meio | — |

O shutdown inverso importa: sem ele, `governance` poderia sair enquanto `market-stalls` — que o consome — ainda atende pedido.

Erro no `shutdown` de um módulo não impede o desligamento dos demais, e o módulo que falhou ao desligar **não continua "ativo"**.

Em 16/08/2026, os ciclos isolados de `death`, `npc-cleaner` e `voip` passaram a
ter testes de stop/restart: timers e estado do serviço de morte são cancelados,
o cleaner não abre dois intervalos, e o WebSocket de voz libera a porta para
bind imediato. Isso valida os recursos próprios desses módulos; não comprova o
hot reload completo do SkyMP, que ainda depende de sessão real e da observação
de hooks/listeners mantidos pela engine. A barreira entre instâncias e o
protocolo operacional estão em
[`HOT_RELOAD_LIFECYCLE.md`](../technical/HOT_RELOAD_LIFECYCLE.md).

---

## 5. As três fases

| Fase | Significa | Está no `phase0-basic.js`? |
|---|---|---|
| `core` | Infraestrutura. Sem gameplay próprio | Sim |
| `lab` | Mecânica em validação. **Desligada por padrão** | Sim |
| `parked` | Existe no disco, **nunca registrada** | Não |

**PARKED não é "desligado".** Um módulo desligado tem descritor e uma flag em `false`; um módulo PARKED não tem descritor nenhum. Reativá-lo é escrever o descritor — o que exige revisar o que o parkeou.

`CONTRIBUTING.md` §3.3 é explícito: nunca importe um módulo PARKED diretamente. `moduleRegistry.isEnabled()` é o portão, e ele só responde `true` para módulo que o registry inicializou de fato.

PARKED hoje: `economy-regional`, `jobs-service`, `crafting-service`, `housing-service`, `trade-service`, `horse-service`.

---

## 6. Registrar um módulo novo

1. Escreva o serviço em `skymp/gamemode/`.
2. Adicione o descritor em `phase0-basic.js`, fase `lab`, flag `ENABLE_<NOME>`.
3. Declare `dependencies: ['interaction']` se ele registrar interações.
4. Documente a flag no `.env.example`.
5. Escreva o teste. `npm test` roda a suíte inteira.

Não é preciso pensar na posição do bloco no arquivo: a ordenação topológica resolve.

---

## 7. Diagnóstico

```js
moduleRegistry.list()
// [{ id, phase, version, state, enabled, enabledBy, envValue,
//    dependencies, optionalDependencies, commandCount }]

moduleRegistry.getState('governance')       // 'RUNNING' | 'FAILED' | 'DISABLED' | ...
moduleRegistry.healthCheckAll()             // [{ id, healthy, error? }]
moduleRegistry.topologicalOrder()           // { ordered, cycles }
```

`healthCheckAll` só olha o que está ativo e isola exceção: um `healthCheck` que lança vira `{healthy: false, error}`, não derruba o relatório.

---

## 8. O que este sistema deliberadamente não faz

**Não distribui eventos de jogo.** O Red House despacha `onHit`/`onCellChange` para qualquer módulo que queira escutar. Avaliado em 06/08/2026 e não feito: dos módulos registrados, **um** escuta evento de jogo (`death`, e só `hit`), e `onCellChange` não tem consumidor nenhum. Um despacho genérico trocaria uma linha por um barramento que serve a um só, com uma chave viva e uma morta desde o primeiro dia.

O precedente do próprio projeto aponta o caminho quando o caso aparece: quando um segundo consumidor surgiu de verdade, a resposta foi `core/panel-refresh-bus.js` — um barramento pequeno e nomeado. `core/death-events.js` nasceu igual, pelo mesmo motivo.

O gatilho para reabrir: um segundo módulo que precise de um evento de jogo já capturado por outro. O raciocínio completo está no cabeçalho do [`module-registry.js`](../../skymp/gamemode/core/module-registry.js).

**Não injeta dependências.** Módulos usam `require` explícito. Ver [`ADR_002`](../technical/ADR_002_INTERACTION_FRAMEWORK.md) §4.
