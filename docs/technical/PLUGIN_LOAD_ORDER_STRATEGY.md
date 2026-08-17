# Estratégia de load order e índice de plugin

Data: **2026-08-14**. Fonte: `skyrim-multiplayer/skymp@d85f18d8` — `skymp5-server/cpp/server_guest_lib/FormDesc.cpp` e `libespm/`. Procedência: **leitura de código-fonte**.

Responde ao briefing §16 e fecha o outro lado do `MOD-005`/`MOD-006` do [roadmap de adaptação](../roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md).

---

## 1. A aritmética inteira

O SkyMP converte entre FormID e descritor de forma com duas linhas:

```cpp
// FormDesc::ToFormId
realFormId = fileIdx * 0x01000000 + shortFormId;

// FormDesc::FromFormId
int fileIdx = formId / 0x01000000;
```

`fileIdx` é a posição do arquivo na load order do servidor. **O primeiro byte do FormID é o índice do plugin, e nada mais.** Forms criados em runtime pelo servidor vivem em `0xFF000000+`, o mesmo espaço dinâmico que o jogo usa.

Daí sai tudo o que importa:

- **O índice não está no arquivo.** Ele é a posição na lista. Duas máquinas com listas diferentes leem o mesmo FormID como coisas diferentes.
- **O texto do descritor é `"<hex-curto>:<arquivo>"`** — `162e2:Skyrim.esm`, nunca `0x…`. Confirmado em `FormDesc::ToString`, que formata com `%0x` sem prefixo.
- **`ToFormId` lança** se o arquivo não está na lista carregada: `"<arquivo> not found in loaded files"`. Nome errado falha alto.
- **`FromString` não lança.** Um descritor malformado passa por `sscanf` e vira `shortFormId = 0` em silêncio. **A entrada é permissiva e a saída é estrita** — a assimetria que produz o bug mais chato dos dois.

---

## 2. ESL: não existe

Busca por `esl`, `light master`, `0xFE`, `isLight` em `libespm/` e `skymp5-server/cpp/`: **zero ocorrências.**

Não há tratamento de plugin *light*. Não há espaço `FE` de índice estendido. Não há leitura do flag `0x200` do cabeçalho TES4. Um `.esl` — ou um `.esp` com o flag ESL ligado — entra na load order do servidor como plugin comum e **consome um índice inteiro**.

No cliente, não. O jogo põe todos os light plugins no espaço `FE` e eles **não** consomem índice na faixa normal.

> **É esse o desalinhamento.** Um único ESL na load order do jogador desloca em um todos os índices seguintes do lado do servidor em relação ao cliente. Todo FormID de todo plugin depois dele passa a apontar para outra coisa.

### O relato de campo que fecha o diagnóstico

O `patches/Skyrim.ccc.README.txt` do The Divine Comedy descreve o sintoma sem saber a causa:

> "Skyrim AE automatically loads the Creation Club content listed in this file (~10 .esm + several .esl). Those plugins occupied indices 05 to 0E and misaligned the plugin indices between client and server, causing the error `FromFormId failed due to invalid file index`."

Essa string existe no upstream, no `throw` de `FormDesc::FromFormId`. **O relato deles e a leitura do nosso fonte se encontram na mesma linha de C++**, e o `several .esl` é exatamente a metade do problema que ninguém tinha nomeado.

A solução deles — esvaziar o `Skyrim.ccc` — continua `REJECT`, pelo motivo que o próprio README declara: reverte quando o Steam verifica os arquivos.

---

## 3. O que o nosso gate faz hoje, e o que ele deixa passar

`apps/launcher/electron/parity.mjs` é bom e cobre mais do que parece:

| Verificação | Estado |
|---|---|
| Plugin do servidor ausente no cliente | ✅ |
| Master declarado no TES4 ausente localmente | ✅ |
| Master carregando **depois** do plugin que depende dele | ✅ |
| Plugin habilitado localmente que o servidor não declara | ✅ |
| Sem load order do servidor → recusa em vez de comparar o jogador consigo mesmo | ✅ — e a decisão está comentada no código |
| Creation Club por `Skyrim.ccc`, nas duas direções | ✅ desde 13/08 |
| **Flag ESL** | ❌ **parseado, testado, e nunca usado** |

O `parsePluginHeader` lê `isLight = (flags & 0x200) !== 0`. Há teste para isso (`parity.test.mjs:108`). O campo aparece no tipo em `main.ts:45`.

**`analyzePlugins` nunca o consulta.** O launcher sabe que o plugin é ESL e não diz nada.

Não é bug de lógica — é um dado colhido e não usado. Custa uma condição.

---

## 4. A estratégia

Quatro camadas, da mais barata para a mais cara. As três primeiras não dependem da Fase 0.

### `LOP-001` — ESL vira problema no gate do launcher

`analyzePlugins` passa a acusar todo plugin com `isLight` na load order do servidor. Mensagem que diz a causa, não o sintoma: *"X é um plugin light (ESL). O servidor conta índice para ele e o jogo não — todo FormID depois dele fica deslocado."*

É a menor mudança com maior efeito de todo este documento. Um `if`, uma mensagem e um teste.

### `LOP-002` — a load order do servidor vem do servidor

`mp.getEspmLoadOrder()` devolve, **em runtime**, os nomes de arquivo que o servidor realmente carregou — na ordem em que ele os indexa. É a fonte de verdade.

Hoje o manifesto declara a load order pretendida. `getEspmLoadOrder` diz a efetiva. Entre as duas cabe um erro de configuração inteiro: um plugin listado que não abriu, um caminho relativo que resolveu para outro arquivo, uma diferença de caixa.

Desde 16/08/2026, o gamemode compara essa lista com
`server-settings.loadOrder` e com o `loadOrder` do mesmo manifesto Ed25519 que a
`game-api` serve ao launcher. Como o boot é recusado quando qualquer uma das
três diverge, o manifesto público passa a representar a ordem efetivamente
carregada, não apenas a intenção de configuração.

### `LOP-003` — gate de boot server-side

O `MOD-006` do roadmap, vindo do `loadOrderGate.js` do Frostfall, com uma peça que a nossa versão pode ter e a deles não: **`getEspmLoadOrder` comparado contra o manifesto no próprio boot.**

Implementado em `core/load-order-gate.js` e ligado antes de `db.init()`. O
servidor se recusa a subir se o manifesto estiver ausente, inválido, expirado
ou se a lista efetiva/configurada divergir da assinada. Falha cedo, alto, e na
máquina que a operação controla — em vez de falhar na máquina do jogador, no
meio de uma cena, como `"invalid file index"`.

Mesma filosofia *fail-closed* do `server-options`.

### `LOP-004` — decisão de produto sobre Creation Club

Continua aberta desde 13/08 e é a única aqui que não é técnica.

`docs/MODPACK.md` lista cinco plugins de Creation Club como masters obrigatórios. Isso faz o modpack depender de **todo jogador ter as mesmas licenças de CC** — e as licenças de CC variam por conta Steam.

As saídas continuam sendo duas: exigir o conteúdo e aceitar barrar quem não tem, ou remover as entradas 6 a 10 junto com os mods que dependem delas. A segunda continua parecendo mais barata, e agora tem um argumento a mais: **parte do conteúdo de CC é `.esl`**, e ESL é justamente o que o SkyMP não sabe indexar.

---

## 5. Regras para quem mexe em load order

1. **Nenhum `.esl`, e nenhum `.esp` com o flag light, na load order do servidor.** Sem exceção enquanto o `libespm` não os tratar.
2. **A ordem do servidor é a autoridade.** O cliente se conforma; o gate recusa quando não dá.
3. **Descritor de forma é `"<hex>:<Arquivo.esm>"`, minúsculo e sem `0x`.** Ver `core/papyrus.js`.
4. **Plugin novo entra no fim da lista.** Inserir no meio renumera tudo depois e invalida todo FormID persistido no banco que aponte para os deslocados.
5. **Mudou a load order? Confira o que está persistido.** FormIDs guardados em tabela nossa foram gravados sob uma numeração. Se ela mudar, eles passam a apontar para outra coisa — sem erro, sem log.

A regra 5 é a mais fácil de esquecer e a mais cara. É a mesma armadilha do `Skyrim.ccc`, um nível acima.

---

## 6. Cabe PR upstream?

Suporte a ESL no `libespm` e no `FormDesc` é a lacuna mais genérica que esta pesquisa encontrou: atinge todo servidor SkyMP que aceite modpack moderno, e o Divine Comedy é a prova de que atinge mesmo.

Também é a maior. Mexe no formato do descritor, na aritmética de índice, na persistência de todo `ChangeForm` já salvo, e na compatibilidade de bancos existentes. Não é um patch — é um projeto.

**Recomendação: abrir issue, não PR.** Descrever o mecanismo, o sintoma, e a evidência do Divine Comedy. Issue não passa pelo CAA (ver [política de patch](SKYMP_PATCH_POLICY.md) §5), custa uma tarde, e um relato bom com repro vale mais do que um PR grande que ninguém vai revisar.

---

## 7. O que continua sem prova

- **Nada aqui foi testado em jogo.** A não-existência de ESL é ausência de código, que é a evidência mais forte disponível sem sessão — mas continua sendo leitura.
- **`getEspmLoadOrder` agora faz parte do boot, mas o retorno ainda não foi
  observado neste binário SkyMP com o manifesto real.** A assinatura é
  conhecida e a integração possui teste estrutural; a forma/ordem real continua
  pendente de runtime.
- **A hipótese do deslocamento por ESL é dedução**, apoiada pelo relato do Divine Comedy. Confirmá-la exige um servidor com um ESL na lista e um cliente — e isso é exatamente o tipo de coisa que não se descobre sem a Fase 0.
