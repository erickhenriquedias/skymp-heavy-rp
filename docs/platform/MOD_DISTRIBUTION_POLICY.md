# Política de distribuição de mods

Data: **2026-08-13**. Define o que o launcher do Heavy RP pode baixar e entregar ao jogador, o que ele pode apenas **verificar**, e como o manifesto codifica a diferença.

> **A regra que governa tudo abaixo:** nenhum arquivo é distribuído sem autorização verificada. Na dúvida, não distribui — e o manifesto tem uma categoria própria para "não distribui, mas exige".

Documentos relacionados:
- [`docs/legal/ASSET_LICENSE_REGISTRY.md`](../legal/ASSET_LICENSE_REGISTRY.md) — o registro obrigatório, asset por asset. **Esta política não o substitui**: ela diz como o launcher se comporta; aquele diz o que a permissão de cada autor permite.
- [`docs/MODPACK.md`](../MODPACK.md) — a lista concreta de mods.
- [`docs/research/PLATFORM_INFRASTRUCTURE_AUDIT.md`](../research/PLATFORM_INFRASTRUCTURE_AUDIT.md) §7 — o formato de manifesto v2 que esta política preenche.
- [`docs/technical/LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) §5 — por que não usamos o formato de Nexus Collections.

---

## 1. O problema, em uma frase

O launcher precisa garantir que todo jogador tenha **os mesmos bytes** que o servidor espera, mas não tem o direito de **entregar** a maior parte desses bytes.

As duas metades são separáveis, e essa é a única razão pela qual o problema tem solução:

- **Verificar** paridade exige só o hash. Publicar um SHA-256 de um arquivo de terceiro não redistribui nada — é uma afirmação sobre bytes, não uma cópia deles.
- **Distribuir** exige permissão.

Todo o desenho abaixo é uma consequência de manter essas duas metades separadas no formato do manifesto.

Isto é também o que o [F02K/SkyMP-Launcher](https://github.com/F02K/SkyMP-Launcher) faz — o manifesto assinado deles carrega slug de Collection, revisão, lista de plugins, load order e hashes, e **exclui os arquivos**. A conclusão de desenho é a mesma, chegando por caminhos diferentes.

---

## 2. As quatro categorias

Todo arquivo do modpack cai em exatamente uma. A categoria é declarada no manifesto e determina o comportamento do launcher.

| Categoria | Significa | `downloadUrl` | O launcher |
|---|---|---|---|
| `redistributable` | Autoria própria, ou permissão explícita e registrada | presente | baixa, verifica, instala |
| `manual-install` | Permissão ausente, negada, ou não verificada | **ausente** | verifica; se faltar, instrui e **bloqueia a entrada** |
| `nexus-required` | Subconjunto de `manual-install`: existe no Nexus e exige conta/aceite dos termos | **ausente** | idem, e abre a página do mod |
| `license-restricted` | Redistribuição proibida por licença ou por titularidade (Bethesda, Creation Club) | **ausente, sempre** | verifica presença e versão; nunca baixa, nunca instrui a obter fora do canal legítimo |

### `redistributable`

Só entra aqui com **registro em `ASSET_LICENSE_REGISTRY.md`**. As três origens aceitas:

1. **Autoria própria** — `HeavyRP_Equipment.esm`, `HeavyRP_Props.esm`, `HeavyRP_Animations.esm`, plugins gerados por nós.
2. **Licença aberta declarada** pelo autor — "Open Permissions" no Nexus, Creative Commons compatível, MIT/GPL para código.
3. **Autorização direta e escrita** do autor, obtida pelo procedimento §2 daquele registro.

A terceira exige guardar a evidência. Uma permissão lembrada de memória não é permissão; o registro precisa apontar para a mensagem, o print ou o e-mail.

O componente SkyMP em si (cliente, `SkyrimPlatform`, SKSE plugins do fork) entra aqui pela licença própria dele — mas continua sendo `redistributable` **por licença verificada**, não por hábito. Se a licença do upstream mudar, muda a categoria.

### `manual-install`

O caso normal e o que a política existe para tratar. A maioria dos mods de Nexus tem permissão fechada por padrão: *"You are not allowed to upload this file to other sites"*.

Nada disso impede o servidor de **exigir** o mod. Impede de **entregá-lo**.

Comportamento exigido do launcher:

1. Verifica se o arquivo existe em `Data/` e se o `sha256` bate.
2. Se falta ou diverge, entra em `ERROR` com código `MOD_MANUAL_REQUIRED` — não em `REPAIRING`, porque não há o que reparar automaticamente.
3. A tela mostra: nome do mod, autor, link da página oficial, versão exigida, e o motivo de não ser baixado automaticamente ("o autor não autoriza redistribuição").
4. **Não** oferece "baixar mesmo assim", não espelha, não faz proxy, não busca em mirror de terceiro.

O item 4 não é excesso de zelo. Um espelho "só para os jogadores do servidor" é redistribuição; a audiência restrita não muda a natureza do ato.

### `nexus-required`

Igual a `manual-install`, com dois acréscimos: o launcher abre a página no navegador do sistema (nunca dentro de uma janela do Electron, que é o que faria parecer que somos nós entregando), e o texto avisa que baixar exige conta no Nexus.

**Nunca automatizar o download do Nexus.** A Nexus API tem termos, e usar credencial de jogador para buscar arquivo em nome dele é uma integração de verdade — com consentimento, com tratamento de token, com responsabilidade sobre o que acontece se falhar. Não é um atalho de conveniência, e não está no escopo desta política.

### `license-restricted`

Bethesda, e conteúdo Creation Club.

- **`Skyrim.esm`, `Update.esm`, DLCs**: o jogador precisa possuir o jogo. Já é regra do repositório e é verificada na CI (`.github/workflows/ci.yml`, passo "Nenhum asset da Bethesda", que recusa qualquer `.esm` ou `.bsa` versionado).
- **Creation Club** (`ccbgssse001-fish.esm` e as demais entradas 6–10 de `MODPACK.md`): não é só proibido redistribuir, é **impossível de garantir** que o jogador tenha — o conteúdo do `Skyrim.ccc` varia conforme o que a conta Steam possui. O launcher já detecta a divergência nas duas direções (`analyzeCreationClub` em `apps/launcher/electron/parity.mjs`).

  A decisão de **exigir ou não** CC no modpack continua aberta (`MOD-005` do roadmap, e o aviso no próprio `MODPACK.md`). Esta política não a decide; ela só fixa que, decidida qual for, o arquivo nunca sai daqui.

---

## 3. O que o manifesto carrega

Formato v2, campos relevantes a esta política (o formato completo está na §7 da auditoria):

```jsonc
{
  "path": "Data/AlgumMod.esp",
  "size": 4194304,
  "sha256": "…",
  "required": true,
  "category": "plugin",
  "distribution": {
    "policy": "manual-install",              // as quatro categorias da §2
    "displayName": "Nome do mod",
    "author": "Autor",
    "sourceUrl": "https://www.nexusmods.com/…",
    "requiredVersion": "3.1.4",
    "licenseRef": "AL-014"                   // aponta pro ASSET_LICENSE_REGISTRY
  },
  "downloadUrl": "https://…"                 // SÓ quando policy === "redistributable"
}
```

Duas invariantes, e elas devem ser verificadas **na geração**, não na leitura:

1. **`downloadUrl` presente ⟺ `policy === "redistributable"`.** Um manifesto que traga URL para um arquivo `manual-install` é um erro de publicação, e o gerador deve recusar produzi-lo. Confiar no launcher para não usar a URL é confiar no lugar errado.
2. **`policy === "redistributable"` exige `licenseRef` resolvível** em `ASSET_LICENSE_REGISTRY.md`. Um arquivo distribuível sem registro de licença não é distribuível; é um arquivo que ninguém conferiu.

O `sha256` está presente nas quatro categorias. **Publicar hash não é redistribuir** — é o que permite exigir paridade de um arquivo que não entregamos, e é a razão pela qual o problema todo tem solução.

---

## 4. O que isto custa ao jogador, e por que aceitamos

Um modpack cheio de `manual-install` significa que a primeira entrada no servidor tem trabalho manual. É pior que "clicar em jogar", e vale ser explícito sobre o trade-off em vez de fingir que ele não existe.

Três mitigações legítimas, em ordem de preferência:

1. **Encolher a lista.** Todo mod `manual-install` é atrito. A pergunta "este mod vale o custo de instalação manual para todo jogador?" deve ser feita na curadoria, não descoberta depois.
2. **Pedir permissão.** É o procedimento §2 do `ASSET_LICENSE_REGISTRY`, e funciona mais do que se espera — autores costumam autorizar servidores que pedem e creditam.
3. **Substituir por autoria própria.** É o que a §3 das [Diretrizes de Modding](../MODDING_GUIDELINES.md) já manda para objetos de gameplay.

O que **não** é mitigação: espelhar, empacotar "só para membros", ou distribuir por Discord. As três são a mesma coisa com nomes diferentes.

---

## 5. Créditos

`ASSET_LICENSE_REGISTRY.md` §4 já exige um botão "Créditos" no launcher. **Ele não existe hoje** — não há tela de créditos em `apps/launcher/src/`. Fica registrado aqui como pendência, porque é obrigação assumida com autores cujo trabalho estamos usando, e uma obrigação assumida e não cumprida é pior que uma não assumida.

O conteúdo mínimo: para cada arquivo com `distribution.author`, o nome do autor e o link da fonte. O manifesto já carrega os dois campos, então a tela é uma leitura do manifesto, não uma lista mantida à mão — que é justamente o tipo de lista que envelhece e mente.

---

## 6. Quando esta política é violada

Se um arquivo for distribuído sem autorização:

1. Remover do canal de distribuição imediatamente (release do GitHub, e o manifesto que aponta para ele).
2. Registrar em `ASSET_LICENSE_REGISTRY.md` o que aconteceu e quando — o registro serve para o histórico, não só para o presente.
3. Se houve contato do autor, responder. Não distribuir de novo até haver autorização escrita.

Precisa existir um canal de contato **nomeado para autores de mod**. O [`SECURITY.md`](../../SECURITY.md) tem um ("contato direto com o mantenedor pelo Discord do projeto"), mas está declarado para relato de vulnerabilidade — um autor procurando pedir remoção de um arquivo não tem por que encontrá-lo ali. Fechar essa lacuna, no README ou em documento próprio, é pré-requisito de qualquer distribuição pública.

---

## 7. O que esta política não faz

- **Não classifica os mods de `MODPACK.md`.** A tabela lá lista arquivos e links, sem coluna de permissão. Preencher categoria por categoria é trabalho de curadoria e exige abrir a aba "Permissions and credits" de cada mod, um por um.
- **Não classifica licenças automaticamente.** O manifesto v2 e o
  `distribution-map.json` estão implementados, mas decidir quais arquivos podem
  receber `downloadUrl` continua sendo responsabilidade humana de curadoria.
- **Não substitui aconselhamento jurídico.** É uma política operacional escrita por quem desenvolve, alinhada ao que os termos do Nexus e as permissões de autor declaram.
- **Não decide sobre Creation Club.** `MOD-005` continua aberta.
