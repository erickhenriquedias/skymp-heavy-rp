# Como um mod se comporta dentro do gamemode

***Português** · [English](MODS_AND_GAMEMODE_CONTRACT.en.md) · [Русский](MODS_AND_GAMEMODE_CONTRACT.ru.md) · [Español](MODS_AND_GAMEMODE_CONTRACT.es.md)*

`docs/MODDING_GUIDELINES.md` diz **o que** é permitido e **por quê** (política, lista negra, fases). Este documento é a outra metade: **o que tecnicamente acontece** com um mod quando ele entra num cliente conectado ao nosso servidor, com base no código que existe hoje em `skymp/gamemode/`.

Serve pra responder, sem achismo, a pergunta que sempre volta: *"esse mod funciona no servidor?"*

---

## 1. As três camadas, e onde cada mod cai

Um cliente conectado ao nosso servidor tem três camadas independentes. Um mod age em uma ou mais delas, e é isso que decide o destino dele.

| Camada | Quem manda | O que um mod consegue fazer aqui |
|---|---|---|
| **Assets** (`.nif`, `.dds`, som, animação) | O cliente, localmente | Trocar aparência livremente. O servidor nunca lê malha nem textura. |
| **Records do plugin** (`.esp`/`.esm`/`.esl`: FormIDs, stats, receitas, leveled lists) | O plugin, **igual em todo mundo** | Definir o que existe no mundo. Só funciona se **todos** tiverem o mesmo plugin na mesma posição. |
| **Lógica de gameplay** (quem tem o quê, quem pode o quê, quanto custa) | O gamemode Node.js, no servidor | **Nada.** Script de mod não é consultado em nenhuma decisão. |

A confusão quase sempre nasce de tratar as três como uma coisa só, porque no single-player elas são.

---

## 2. Por que scripts Papyrus de mod não têm efeito de gameplay

O gamemode não escuta o Papyrus — ele **chama** o Papyrus. O tráfego é de mão única, do servidor pro cliente.

Todo o vocabulário que o servidor usa hoje contra o jogo cabe nesta lista (levantada dos `mp.callPapyrusFunction` do `skymp/gamemode/`):

```
Debug.notification          Debug.SendAnimationEvent    Game.getFormEx
Actor.getActorValue         Actor.SetActorValue         Actor.GetItemCount
Actor.PlayIdle              Actor.Resurrect
ObjectReference.AddItem     ObjectReference.RemoveItem
ObjectReference.disable     ObjectReference.delete
```

São todos **imperativos**: "mostre isso", "toque essa animação", "coloque esse item aí". Não existe nenhum ponto onde o servidor pergunte ao cliente "e aí, o que aconteceu?" e acredite na resposta.

*(Nota de 06/08/2026: o servidor também consegue **ler os registros dos plugins** via `mp.lookupEspmRecordById(formId)` — dano base de arma, valor de armadura, perks, raça. Isso não muda a regra acima, mas amplia o que dá pra validar sem confiar no cliente: o servidor pode conferir o dano de uma arma contra o ESM em vez de contra uma tabela nossa. Ver `REFERENCE_STUDY_SKYMP_RED_HOUSE.md` 4.1.)*

A consequência prática:

- Um mod que adiciona um script `OnActivate` numa bancada **roda** no cliente que o instalou. Mas se ele der um item, esse item existe apenas na tela daquele jogador — não passa por `core/transaction-service.js`, então não está em `character_inventory`, não aparece no `/painel`, e some no próximo login.
- Um mod de economia que muda preços de mercador muda o menu vanilla local. As barracas de jogador (`market-stalls-service.js`) leem preço de `market_stall_items` no MySQL e nem olham pro record.
- Um mod de sobrevivência que aplica um efeito de fome altera o `ActorValue` local. O `death-service.js` lê `Actor.getActorValue('Health')` por polling e vai enxergar a queda — isto é, um mod de sobrevivência **consegue** derrubar o personagem de alguém no nosso sistema de `DOWNED`. É exatamente por isso que scripts de sobrevivência estão na lista negra do lado do cliente.

Esse último caso é a regra geral que vale a pena internalizar: **mod não consegue criar estado, mas consegue mexer em ActorValue, e o servidor lê ActorValue.** Todo mod que mexe em vida, stamina ou magicka precisa ser tratado como mod de gameplay, mesmo que se anuncie como visual.

---

## 3. O contrato de FormID

O que o servidor **de fato** compartilha com os plugins são FormIDs. Eles aparecem em três lugares no código:

- `core/transaction-service.js` grava `character_inventory (character_id, base_id, count)` — `base_id` é um FormID.
- `admin-service.giveItemAdmin(actorId, targetActorId, baseId, count)` e o comando `/additem <actorId> <baseId> <count>`.
- `market-stalls-service.js` guarda o `base_id` de cada item anunciado e usa `Game.getFormEx` + `PlaceAtMe` pra materializar a barraca.

Um FormID carrega o índice de load order no primeiro byte (`0xXX......`). Daí sai a regra dura:

> **Se a load order de dois jogadores diferir em uma única posição, os FormIDs se deslocam e o mesmo `base_id` no banco vira um item diferente na tela de cada um.**

Não é um bug que dá pra contornar com mais validação no servidor — o banco guarda um número que só significa alguma coisa dentro de uma load order específica. É por isso que a paridade de plugins é obrigatória e não uma preferência de qualidade.

É também o motivo de o launcher (`apps/launcher/electron/main.ts`) fazer duas coisas separadas:

1. `verify-mods`: autentica o envelope Ed25519 de paridade v2 e compara tamanho e SHA-256 de cada path canônico, inclusive subdiretórios de `Data/`, com `mods.json` do servidor — garante que o **conteúdo** é igual.
2. `analyze-plugins`: lê o header de cada plugin, confere se todos os masters existem e se aparecem **antes** do dependente — garante que a **ordem** é igual.

As duas juntas é que sustentam o contrato. Uma sozinha não basta.

---

## 4. Teste prático pra classificar um mod

Antes de mandar um mod pras fases de QA do `MODDING_GUIDELINES.md`, passe por estas quatro perguntas. Elas separam "aprovado direto" de "precisa de teste" de "rejeitado" mais rápido do que ler a página do Nexus.

**1. Ele tem `.esp`/`.esm`/`.esl`?**
Não → é replacer puro de asset. Cai na camada 1, praticamente sempre aprovável como opção visual (Perfil 2).
Sim → continua.

**2. Ele tem scripts (`.pex`) ou depende de SKSE?**
Sim → assuma lógica local. Só entra se a lógica for puramente cosmética (câmera, HUD, UI). Qualquer coisa que conceda item, mude preço, altere ActorValue ou dispare evento de mundo é rejeitada — não porque vá "quebrar", mas porque cria uma segunda autoridade sobre o estado, e aí o jogador vê uma coisa e o banco diz outra.

**3. Ele adiciona ou reordena records?**
Sim → obrigatoriamente entra no Perfil 1 (idêntico pra todos) e num slot fixo de load order. Não pode ser opcional. Se não vale a pena tornar obrigatório pra todo mundo, não vale a pena adicionar.

**4. Ele mexe em NPCs, spawn ou células?**
Sim → o servidor tem autoridade sobre atores (`npc-cleaner.js`, `mp.getActorsByProfileId`). Mod que adiciona ou reposiciona NPC entra em conflito direto. É a origem da rejeição de Immersive Citizens, Open Cities e JK's Skyrim na lista negra.

---

## 5. O que muda quando o mod é nosso

Plugins próprios (`HeavyRP_Equipment.esm`, `HeavyRP_Props.esm`) não fogem de nada acima — só nos dão as duas coisas que não temos com mod de terceiro:

- **FormIDs estáveis**, que a gente escolhe e não reordena.
- **Nenhum script**, porque a lógica correspondente é escrita como serviço em `skymp/gamemode/` e passa pelo `core/module-registry.js`, `core/action-policy.js` e `core/transaction-service.js` como qualquer outra feature.

Ou seja: um "mod nosso" é sempre um par — um plugin sem script que declara o que existe, e um serviço Node que decide o que acontece.

---

## 6. Referências cruzadas

- `docs/MODDING_GUIDELINES.md` — política, perfis, fases de QA, lista negra.
- `docs/technical/LAUNCHER_DISTRIBUTION.md` — como a paridade é distribuída e verificada na prática.
- `docs/technical/MARKET_STALL_VISUAL_ASSET_PLAN.md` — aplicação deste teste a um caso concreto (barracas).
- `docs/legal/ASSET_LICENSE_REGISTRY.md` e `docs/technical/LICENSE_AND_AFFILIATION_POLICY.md` — o lado de licenciamento, que é uma barreira separada e independente da técnica.
