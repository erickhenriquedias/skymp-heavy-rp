# Patches ao SkyMP e ao SkyrimPlatform

**Estado atual: um patch cliente registrado (`launcher-session-settings-auth`).** A política continua sendo voltar a zero assim que o upstream oferecer handoff equivalente.

Ele existe porque a hora de escrever a política é antes do primeiro patch, não depois do quinto. Todo projeto do ecossistema SkyMP que acabou mantendo um fork pesado começou com um patch sem registro — [`SKYMP_ECOSYSTEM_DEEP_DIVE.md`](../docs/research/SKYMP_ECOSYSTEM_DEEP_DIVE.md) documenta os casos.

> **A decisão de *se* um patch deve existir está em [`SKYMP_PATCH_POLICY.md`](../docs/technical/SKYMP_PATCH_POLICY.md).** Este arquivo explica *como* registrar um, depois que a decisão foi tomada.

## A escada de decisão

Antes de escrever um patch, desça esta escada e pare no primeiro degrau que resolver. Patch é o penúltimo recurso; fork é o último.

```
1. SkyMP puro          — a API atual já resolve?
2. Adapter             — dá pra resolver do nosso lado da fronteira?
3. Client extension    — é UI, input, animação ou detecção local?
4. PR upstream         — é um bug ou lacuna que serve a todo mundo?
5. Patch registrado    — precisamos disso antes do upstream aceitar?
6. Fork                — só com ADR e justificativa escrita
```

**Os degraus 1 a 3 não precisam de nada disto.** A [auditoria de 14/08](../docs/research/SKYMP_INTEGRATION_AUDIT.md) desceu esta escada para doze problemas concretos e **onze pararam ali**.

Se você chegou ao degrau 4, abra o PR e registre o patch como ponte temporária, com o link do PR no campo `upstream_pr` — e leia antes a [§5 da política](../docs/technical/SKYMP_PATCH_POLICY.md), porque desde 18/07/2026 o upstream exige cessão de direito autoral de quem contribui.

Um patch cuja intenção é virar PR e nunca vira é um fork começando devagar.

## Por que "condição de perda" é campo obrigatório

É a contribuição do [The Divine Comedy](https://github.com/miguelAngeloo/TheDivineComedy), o único projeto do ecossistema que documenta isso, e é o campo que quase ninguém escreve.

Eles anotam, no README dos próprios patches, que o patch de `spawn.ts` some num reclone do SkyMP e que o `Skyrim.ccc` esvaziado volta se o Steam verificar os arquivos do jogo. Sem esse registro, o patch desaparece e o sintoma reaparece meses depois como bug novo — e ninguém liga uma coisa à outra.

**Um patch cuja perda é silenciosa é pior que patch nenhum:** você passa a confiar num comportamento que pode sumir sem aviso.

## Como registrar um patch

1. Salve o diff em `<alvo>/<slug>.patch` — `<alvo>` é `skymp` ou `skyrim-platform`.
2. Confira que `upstream.pin` em [`manifest.json`](manifest.json) é o commit contra o qual o diff foi gerado. **Todos os patches apontam para o mesmo pin** — se o seu precisa de outro, o pin é que sobe, e aí todo patch é reavaliado.
3. Acrescente uma entrada em `manifest.json`.
4. Rode `node validate.js`. A CI roda o mesmo, mais `git apply --check` do diff contra o upstream no commit do pin.

### Campos

| Campo | Obrigatório | O que escrever |
|---|---|---|
| `id` | sim | Slug único, kebab-case |
| `target` | sim | `skymp` ou `skyrim-platform` |
| `file` | sim | Caminho do `.patch` relativo a este diretório; o arquivo precisa existir |
| `upstream_commit` | sim | SHA do commit upstream sobre o qual o diff aplica. Precisa ser o `upstream.pin` do manifesto, ou um prefixo dele de 7+ caracteres |
| `reason` | sim | O problema. Não o que o patch faz — **o que quebra sem ele** |
| `files_touched` | sim | Lista de arquivos upstream modificados |
| `impact` | sim | O que muda em runtime, incluindo risco |
| `test` | sim | Como se prova que funciona. `null` só com justificativa em `notes` |
| `loss_condition` | sim | **O que faz este patch sumir.** Nunca `null` |
| `removal_strategy` | sim | O que precisa ser verdade para apagar o patch |
| `upstream_pr` | sim | URL do PR, ou `null` com o motivo de não caber upstream |
| `added` | sim | Data ISO |
| `notes` | não | Contexto livre |

### Exemplo preenchido

Este patch **não existe**. Está aqui para mostrar o formato — é o `onPlayerSpawn` do Divine Comedy, que seria nosso candidato mais plausível se algum dia precisássemos dele.

```json
{
  "id": "gamemode-spawn-hook",
  "target": "skymp",
  "file": "skymp/gamemode-spawn-hook.patch",
  "upstream_commit": "d85f18d",
  "reason": "O gamemode não consegue decidir onde o jogador nasce; o spawn é resolvido dentro do servidor antes de qualquer hook.",
  "files_touched": ["skymp5-server/src/systems/spawn.ts"],
  "impact": "Se o gamemode expõe `onPlayerSpawn`, ele decide o spawn. Sem isso, comportamento idêntico ao upstream.",
  "test": "skymp/gamemode/spawn.test.js — cobre com hook e sem hook",
  "loss_condition": "Reclone ou atualização do SkyMP. O arquivo é sobrescrito sem aviso e o spawn volta ao padrão.",
  "removal_strategy": "Apagar quando o PR upstream for aceito e o pin de versão subir para além dele.",
  "upstream_pr": null,
  "added": "2026-08-13",
  "notes": "Desenhado para ser upstreamable: não muda comportamento de quem não expõe o hook."
}
```

## O que não entra aqui

**Sobrescrever fonte upstream por cópia.** O Divine Comedy também tem um `sync-client.mjs` que copia o diretório deles por cima de `skymp5-client/src`, com caminho absoluto da máquina do autor. É sobrescrita silenciosa, sem diff e sem registro: ninguém consegue dizer depois o que foi trocado. Se precisar mudar arquivo upstream, é patch com diff.

**Mudança de ambiente do jogo.** Esvaziar `Skyrim.ccc`, mexer em INI, alterar arquivo instalado pelo Steam. Isso não é patch de código, reverte sozinho, e pertence ao gate do modpack — ver `MOD-005` no [roadmap](../docs/roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md).
