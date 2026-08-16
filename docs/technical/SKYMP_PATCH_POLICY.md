# Política de patch ao SkyMP

Data: **2026-08-14**. Substitui a política que vivia dentro de [`patches/README.md`](../../patches/README.md), que passa a ser o manual de operação do diretório.

**Este documento decide *se* um patch deve existir. O `patches/README.md` explica *como* registrá-lo.**

Estado atual: **um patch registrado**, `launcher-session-settings-auth`, para o handoff de sessão externa e redaction do bearer no log. A condição de remoção está no manifesto; zero patches continua sendo o estado preferido.

---

## 1. A escada

Antes de escrever um patch, desça esta escada e pare no primeiro degrau que resolver.

```
1. SkyMP puro         — a API atual já resolve?
2. Adapter            — dá para resolver do nosso lado da fronteira?
3. Client extension   — é UI, input, animação ou detecção local?
4. PR upstream        — é bug ou lacuna que serve a todo mundo?
5. Patch registrado   — precisamos disso antes de o upstream aceitar?
6. Fork               — só com ADR e justificativa escrita
```

Os degraus 1 a 3 não exigem nenhum registro. Do 4 para baixo, tudo é registrado.

A [auditoria de 14/08](../research/SKYMP_INTEGRATION_AUDIT.md) desceu essa escada para doze problemas concretos. **Onze pararam nos três primeiros degraus.** O décimo segundo — o par montado do Hijos — é o único candidato legítimo a patch que o projeto tem, e já estava em P6.

Isso não é sorte. É o resultado previsível de descobrir que a API do SkyMP tem 40 métodos e doze hooks, e que usávamos catorze métodos e um hook.

### Como cada degrau se justifica

**1 — SkyMP puro.** O teste é: *existe método ou hook que faça isso?* A resposta só vale se vier de `ScampServer.cpp` ou de `gamemode_events/`, não da documentação oficial, que descreve cinco dos quarenta métodos. A [§2 da auditoria](../research/SKYMP_INTEGRATION_AUDIT.md) tem a lista completa.

**2 — Adapter.** Vale quando o problema é *forma*, não capacidade: o dado existe, o método existe, e o que falta é converter, validar ou detectar presença. `mp.kick` recebendo `userId` enquanto meio código tem `actorId` é o caso arquetípico. Ver [`core/skymp-adapter/`](../../skymp/gamemode/core/skymp-adapter/README.md).

**3 — Client extension.** `mp.makeEventSource` injeta JavaScript no cliente, que roda com acesso ao SkyrimPlatform e pode responder ao servidor por `ctx.sendEvent`. Cobre UI, input, animação, efeito visual e detecção local — e **nada mais**, pela regra da §6.

**4 — PR upstream.** Deixou de ser gratuito em 18/07/2026. Ver §5.

**5 — Patch.** Só quando o degrau 4 está em andamento e não podemos esperar, ou quando a mudança é específica demais para caber upstream. Todo patch nasce com data de validade escrita.

**6 — Fork.** Exige ADR. Nunca aconteceu e o objetivo é que não aconteça.

---

## 2. O que um patch precisa declarar

Campos obrigatórios, validados por `patches/validate.js` na CI. A tabela detalhada e o exemplo preenchido estão no [`patches/README.md`](../../patches/README.md).

O que importa aqui é **por que dois deles existem**, porque são os que ninguém escreve espontaneamente:

**`loss_condition` — o que faz este patch sumir.** Contribuição do The Divine Comedy, o único projeto do ecossistema que documenta isso. Eles anotam que o patch de `spawn.ts` some num reclone do SkyMP e que o `Skyrim.ccc` esvaziado volta se o Steam verificar os arquivos do jogo.

> Um patch cuja perda é silenciosa é pior que patch nenhum: você passa a confiar num comportamento que pode sumir sem aviso, e o sintoma reaparece meses depois como bug novo sem ninguém ligar uma coisa à outra.

**`upstream_pr` — o link, ou o motivo de não haver.** Aceita `null`, mas então `notes` precisa explicar. Patch que deveria virar PR e nunca vira é um fork começando devagar.

---

## 3. O pin de commit

O manifesto declara, no topo, o commit upstream contra o qual **todos** os patches se aplicam:

```json
{
  "version": 1,
  "upstream": {
    "skymp": "https://github.com/skyrim-multiplayer/skymp",
    "pin": "d85f18d808f877401c4e20484d2c2f6f73cf9caa"
  },
  "patches": []
}
```

`validate.js` exige que o `upstream_commit` de cada patch seja igual ao pin, ou prefixo dele. A regra parece burocrática e não é: **é o que impede um patch validado contra um commit de janeiro de conviver com outro validado contra um de agosto**, dando a impressão de que os dois foram conferidos ao mesmo tempo.

Quando o pin sobe, todos os patches são reavaliados. É o gatilho do procedimento da [matriz de compatibilidade](SKYMP_COMPATIBILITY_MATRIX.md) §4.

O pin também é a referência que a [matriz de compatibilidade](SKYMP_COMPATIBILITY_MATRIX.md) e a [auditoria de fronteira](../research/SKYMP_INTEGRATION_AUDIT.md) citam. **Um lugar só onde a versão do SkyMP é declarada.**

---

## 4. Validação automática na CI

O briefing §12 pede: *a CI deve verificar que o patch continua aplicável; se o upstream mudar, falhar explicitamente; nunca aplicar patch silenciosamente pela metade.*

São três verificações e elas têm custos bem diferentes.

| Verificação | Onde roda | Custo | Estado |
|---|---|---|---|
| Manifesto completo e coerente | job `higiene`, sem dependências | segundos | ✅ ativo |
| `upstream_commit` bate com o pin | idem | segundos | ✅ ativo |
| `git apply --check` contra o upstream real | job próprio, exige clone | ~1 min | ✅ ativo, **e só roda se houver patch** |

O terceiro é o que responde ao briefing, e o desenho tem uma decisão declarada: **com o manifesto vazio, ele não faz nada.** Clonar 53 MB para verificar zero patches é queimar minuto de runner para produzir a mesma resposta todo dia.

Quando o primeiro patch entrar, o job passa a clonar o upstream no commit do pin e rodar `git apply --check` em cada `.patch`. Falha de aplicação **falha o build**, com o nome do patch e do arquivo.

`git apply --check` é a escolha certa aqui em vez de `git apply`: ele responde "aplicaria por inteiro?" sem escrever nada. É exatamente o "nunca aplicar pela metade" do briefing, e sai de graça.

---

## 5. Contribuição upstream depois do CAA

Em **18/07/2026** o upstream adicionou `CLA.md` — um **Contributor Assignment Agreement** no modelo Harmony, assinado por bot no primeiro pull request.

Não é um CLA de licenciamento. É **cessão de direito autoral** para a *Limited Liability Partnership "POSPELOV SOFT"* (BIN 230440011026, Cazaquistão). Os pontos que mudam nossa decisão:

- **§2.1(a)** — a pessoa cede "all right, title, and interest worldwide in all Copyright covering the Contribution". Onde a cessão não é possível por lei, vira licença exclusiva e irrevogável (§2.1(b)) e, onde nem isso, renúncia a acionar (§2.1(c)).
- **§2.3** — a empresa pode licenciar a contribuição sob **qualquer** licença, incluindo proprietária, contanto que também a licencie sob a licença vigente na data da submissão.
- **§2.4** — renúncia a direitos morais.
- **§2.1(d)** — a pessoa recebe de volta uma licença ampla **sobre a própria contribuição**, e nenhum direito sobre o resto do projeto.

**O que isso não muda:** o SkyMP continua AGPL-3.0 no servidor e GPL-3.0 no cliente, o código já publicado continua livre, e o degrau 4 continua sendo o certo para correções gerais. Ninguém está sendo lesado por acidente.

**O que muda:** o degrau 4 passou a ter preço, e quem paga é a pessoa física que abre o PR, no próprio nome.

### A regra

**Contribuir upstream continua sendo a preferência para correção genérica** — bug, lacuna de API, coisa que serve a todo servidor SkyMP. Os degraus 1 a 3 desta escada só existem porque o upstream é bom, e devolver conserto é como isso continua verdade.

Com três condições:

1. **A pessoa que assina decide.** Ninguém é designado para assinar cessão de direito autoral em nome do projeto. Se quem escreveu a correção não quiser assinar, ela vira patch registrado com `upstream_pr: null` e o motivo em `notes`.
2. **Separar antes de submeter.** O briefing §13 já pedia: a solução genérica vai para o PR, o que é Heavy RP fica aqui. Depois do CAA isso ganha uma segunda razão — cede-se o mínimo.
3. **Nada de gameplay, identidade, economia ou moderação vai upstream.** Não é política de licença, é de escopo: essas coisas não servem a outro servidor e não deveriam sair daqui.

### O que continua livre de qualquer disso

Reportar bug, abrir issue, escrever repro, discutir desenho. **O CAA cobre contribuição de código.** Um bug bem descrito com repro costuma valer mais que o patch, e não custa nada.

Boa parte do que a auditoria de 14/08 encontrou é exatamente isso: `Actor.GetActorValue` não existir é lacuna real da API, e `mp._onSpawnAllowed` parecer um hook sem ser um é uma armadilha que merece pelo menos uma issue.

---

## 6. Autoridade nunca vai para o cliente

O degrau 3 da escada é generoso e tem uma fronteira dura.

**Client extension pode:** desenhar UI, ler input, disparar animação, aplicar efeito visual, detectar evento local e **reportar**.

**Client extension nunca pode:** decidir. Nem dano, nem item, nem ouro, nem permissão, nem posição autoritativa, nem resultado de nada.

Isso já era regra do projeto. A auditoria deu a ela três mecanismos com nome:

- **`blockedEventSources`** — um array na configuração *do jogador* desliga qualquer event source pelo nome. Quem quiser cala o nosso relatório de hit ou de UI sem tocar em nada mais.
- **`ServerJsVerificationService`** — o cliente só executa JS do servidor se a assinatura conferir, quando o peer declara `publicKeys`. Se o peer alvo ainda não resolveu, **todos os event sources falham com `target peer not ready`** e o servidor não fica sabendo.
- **`enableGamemodeDataUpdatesBroadcast: false`** (padrão) — quem já está conectado não recebe event source novo.

Nenhum dos três impede a extensão de cliente de ser útil. Os três impedem que ela seja confiável. **Evento de cliente é dica; o servidor decide.**

---

## 7. Quando isto for revisado

| Gatilho | O que reavaliar |
|---|---|
| Pin do upstream sobe | Todos os patches; a lista de hooks e métodos da auditoria; a lista de funções Papyrus da [política de Papyrus](PAPYRUS_USAGE_POLICY.md) |
| Primeiro patch registrado | O job de `git apply --check` deixa de ser inerte. Conferir que ele realmente falha quando deveria |
| `MOUNT-001` sair do papel | É o primeiro patch de verdade. Esta política existe para esse dia |
| Upstream mudar o CAA | §5 inteira |
| Alguém propuser fork | ADR antes de qualquer linha |
