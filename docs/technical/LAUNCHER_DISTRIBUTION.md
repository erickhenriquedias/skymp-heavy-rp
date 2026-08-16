# Distribuição e paridade de cliente pelo Launcher

Como o `apps/launcher` entrega o jogo e garante que todo jogador conectado tenha os mesmos bytes que o servidor espera. Este documento descreve **o que o código faz hoje**, e marca explicitamente o que ainda não tem servidor do outro lado.

---

## 1. Os quatro canais que o launcher usa

O launcher fala com quatro endereços diferentes. Confundi-los é a origem da maior parte da confusão sobre "de onde vem o modpack".

| Canal | Endereço | Serve pra | Existe hoje? |
|---|---|---|---|
| **Releases do GitHub** | `https://github.com/<VITE_GITHUB_DIST_REPO>/releases/...` | Baixar e atualizar o cliente SkyMP e o modpack | Depende de um repo de distribuição configurado |
| **API do servidor de jogo** | `http://<VITE_SERVER_IP>:<VITE_API_PORT>` (7758) | Paridade de mods (`/mods.json`), fila (`/api/queue/*`) | ✅ `apps/game-api` |
| **Painel web** | `<VITE_PANEL_URL>` (3001, `apps/web`) | Concluir o login do Discord, receber crash reports | ✅ |
| **Servidor de jogo** | `<VITE_SERVER_IP>:<VITE_SERVER_PORT>` (7777) | A sessão em si, via SKSE | ✅ (SkyMP) |

---

## 2. Atualização de cliente e de mods (GitHub Releases)

Dois manifestos separados, ambos em release do `VITE_GITHUB_DIST_REPO`:

- **Cliente** — `releases/latest/download/client-update.json`
  `{ clientVersion, downloadUrl, sha256, sizeBytes, notes }`
- **Modpack** — `releases/download/mods/mods-dist.json`
  `{ modsVersion, downloadUrl | parts[], sha256, contentSig, mandatory, sizeBytes }`

Regras que o código já aplica (`apps/launcher/electron/main.ts`):

- **Hash ausente aborta.** Tanto no cliente quanto em cada parte do modpack, um manifesto sem `sha256` faz o download falhar em vez de instalar sem verificação. Isso é deliberado: um manifesto malformado é indistinguível de um comprometido.
- **SHA-256 confere antes de extrair**, nunca depois.
- **O diretório central do ZIP é inspecionado antes de extrair.** O launcher
  recusa caminhos absolutos ou com `..`, nomes especiais/ADS do Windows,
  colisões que apontariam para o mesmo arquivo, symlinks/junctions e pacotes
  acima dos limites declarados. Também recusa atravessar link já existente no
  destino.
- **Feed, arquivo e redirecionamento usam uma allowlist exata de origem.** Só
  HTTPS na porta padrão e hosts oficiais de GitHub Releases são aceitos;
  credenciais na URL, domínios parecidos e redirects para terceiros são
  recusados. Cada salto é revalidado e o limite é cinco.
- **Download em partes** com `contentSig` por parte, pra pular pedaços que não mudaram — o modpack é grande demais pra rebaixar inteiro a cada versão.
- **Carimbos locais** (`skymp_client_version.txt`, `skymp_mods_version.txt`, `skymp_mods_parts.json`) na pasta do jogo dizem o que está instalado sem precisar re-hashear tudo.

## 3. Paridade em tempo de conexão — **falta o servidor**

Antes de jogar, o launcher roda dois passos:

1. **`verify-mods`** — baixa `http://<SERVER_IP>:<API_PORT>/mods.json`, no formato `{ manifestVersion: 1, channel, build, mods: [{ filename, hash }], loadOrder: [...] }`, e compara o hash de cada arquivo correspondente em `Data/`. **Este passo usa MD5**, não SHA-256 — é uma checagem de integridade/paridade, não uma barreira criptográfica, e é diferente do SHA-256 usado no download (seção 2). Cada arquivo exigido é lido por stream e os hashes são calculados sequencialmente, sem carregar uma BSA inteira na memória. Manifesto legado, versão futura, canal desconhecido ou build vazio é recusado pelo servidor e novamente pelo launcher.
2. **`analyze-plugins`** — lê o header de cada `.esp`/`.esl`/`.esm`, confere que todo master existe localmente e aparece **antes** do dependente na ordem informada pelo servidor.

Os dois juntos é que fecham o contrato de FormID descrito em `docs/technical/MODS_AND_GAMEMODE_CONTRACT.md` seção 3: o (1) garante conteúdo igual, o (2) garante ordem igual.

Quem serve esses endpoints é o **`apps/game-api`**.

### Gerando o `mods.json`

O manifesto não é gerado sob demanda — hashear dezenas de GB dentro de uma requisição HTTP seria lento e daria margem a servir um manifesto inconsistente enquanto alguém copia arquivos pra pasta. Gere offline, a partir da pasta `Data/` de referência do servidor:

```bash
cd apps/game-api && node scripts/generate-mods-manifest.js "D:/SteamLibrary/steamapps/common/Skyrim Special Edition/Data" --plugins-txt "%LOCALAPPDATA%/Skyrim Special Edition/plugins.txt" --channel stable --build "2026.08.16"
```

`--plugins-txt` importa: sem ele o script infere a load order pela ordem alfabética do diretório, que **não** é a load order real do Skyrim. Serve pra teste local, mas em produção geraria um manifesto que reprova clientes corretos. O script avisa alto quando isso acontece.

`--channel` aceita apenas `development`, `beta` ou `stable`. `--build` identifica
o modpack publicado. Sem argumentos, o gerador usa `development` e
`unversioned` para desenvolvimento local; uma publicação deve informar ambos.
O caminho absoluto da pasta `Data` usada na geração não é gravado no JSON
público.

Se o manifesto estiver ausente, corrompido, com `mods` vazio ou com `loadOrder`
vazia, `/mods.json` responde **503**, nunca uma lista vazia — lista vazia
passaria na verificação de paridade do launcher e deixaria qualquer modpack
entrar, que é o oposto do propósito.

### A fila

Capacidade fixa de slots (`QUEUE_CAPACITY`). Quem chega e encontra slot livre entra direto; quem não, fica numa fila FIFO e é promovido quando um slot vaga — por desconexão (o gamemode avisa em `/internal/session/release`) ou por **expiração de reserva**. A expiração é o que impede a fila de travar: sem ela, alguém que fecha o launcher depois de ser admitido seguraria o slot para sempre.

**A fila é autenticada por ticket, não por `discordId`.** `discordId` é público — mandá-lo como prova de identidade deixaria qualquer um entrar na fila no lugar de outro jogador. O ticket inicial é emitido pelo painel na troca de OAuth (seção 4), porque só o painel tem o client secret e portanto só ele pode provar que aquele Discord autenticou de fato. Cada consulta consome o ticket atual e recebe o próximo, então um ticket interceptado já está gasto quando chega em outras mãos.

## 4. Login

O launcher abre o consentimento do Discord, sobe um servidor de callback local em `127.0.0.1:19847` e recebe o `code`. **A troca do `code` por token acontece no painel web** (`POST /api/launcher/oauth/exchange` em `apps/web/server.js`), não no launcher.

O motivo é simples: tudo que é `VITE_*` é embutido no instalador em tempo de build, e o instalador é distribuído aos jogadores. Um client secret ali dentro pode ser extraído por qualquer pessoa que baixe o jogo. O launcher recebe de volta só o perfil público (`discordId`, `username`, `globalName`, `avatar`) — nem o access token, que ele não tem uso pra guardar.

O painel valida o `redirect_uri` contra uma allowlist (`LAUNCHER_REDIRECT_URIS`) pra que um `code` interceptado não possa ser trocado apontando pra um endereço de terceiro.

Junto com o perfil, o painel devolve um **`launchTicket`** (`launch_tickets`, migration v6) — de uso único, TTL de 5 min, guardado como hash SHA-256 pra que um vazamento do banco não vire credencial utilizável. É esse ticket que a fila exige.

### O que acontece com o ticket depois

O `launch-game` grava o ticket de sessão em `skymp5-client-settings.txt` como `gameData.session`. O patch registrado `launcher-session-settings-auth` faz o `authService` do cliente tratá-lo como `AuthGameData.remote`; após conectar, o cliente envia essa sessão ao servidor SkyMP. Com `offlineMode: false`, o servidor resolve a sessão contra o master API — que é o nosso painel (`ARCHITECTURE.md` 1.2.1) — e o `id` devolvido vira o `profileId` autoritativo do gamemode. Ver `AUTH_003_LAUNCHER_SESSION_HANDOFF.md`.

É esse desvio que tira a identidade das mãos do cliente. Com `offlineMode: true`, o cliente poderia declarar `gameData.profileId` e o servidor acreditaria; o launcher online remove esse campo.

Cadeia completa: **Discord** → painel (`launch_tickets`) → fila (`game_sessions`) → `skymp5-client-settings.txt.gameData.session` → cliente SkyMP → servidor SkyMP → master API → `profileId`.

O token de `game_sessions` é resolvido **uma única vez**, por `UPDATE`
condicional atômico. Depois que o Actor recebe o `profileId`, o gamemode pede à
game-api um lease opaco exclusivo daquela conexão antes de consultar a
whitelist. No disconnect ele devolve apenas esse lease; o banco guarda somente
SHA-256 e revoga a linha exata. Uma queda exige obter uma sessão nova pelo
launcher. Isso impede replay indefinido e faz um disconnect atrasado da conexão
anterior virar no-op, sem derrubar a reconexão atual.

Credenciais vencidas não permanecem indefinidamente no MariaDB. A game-api
executa retenção no boot e, com tráfego de fila, no máximo uma vez por intervalo:
por padrão conserva tickets por 24 horas e sessões por 7 dias após `expires_at`,
apagando até 10 lotes de 500 linhas por tabela. Os valores são configuráveis no
`.env.example`; a limpeza usa os índices de expiração das migrations v6 e v8.

No restart, a game-api consulta sessões válidas antes de abrir sua porta e
reidrata somente a ocupação — nunca o token, que existe no banco apenas como
hash. O master API confirma conta + `sessionId` em
`POST /internal/session/connected`; se essa confirmação falhar, o login retorna
503. Como o token já foi consumido de forma segura, o retry operacional usa uma
sessão nova emitida pelo launcher, não reutiliza a credencial anterior.

---

## 5. Por que não usamos o formato de Nexus Collections

Nexus Collections é o formato JSON de modlist usado pelo Vortex. Curadores de mod já conhecem a ferramenta, então a pergunta volta sempre. A resposta é que os dois resolvem problemas diferentes:

| | Nexus Collections | Nossos manifestos |
|---|---|---|
| Público | Um jogador instalando mods na própria máquina | Um servidor garantindo paridade entre clientes |
| Unidade | IDs de mod do Nexus + regras de load order (LOOT) | Arquivo + hash + URL |
| Verificação | Nenhuma — o Vortex instala, não confere se o resultado bate com o de outro jogador | Hash obrigatório; ausência aborta |
| Quem decide a versão | O curador, offline, sem coordenação com um servidor rodando | O nosso servidor, a mesma fonte de verdade da whitelist |
| Load order | Resolvida localmente por LOOT, pode variar entre máquinas | Fixa, ditada pelo servidor |

O ponto decisivo é a última linha. Uma Collection instalada "corretamente" em duas máquinas pode produzir load orders diferentes — e pelo contrato de FormID isso já é o bastante pra que o mesmo `base_id` no banco vire itens diferentes na tela de cada jogador.

**Ainda assim aproveitamos o ecossistema Nexus:** nada impede a staff usar Vortex/Collections como ferramenta de trabalho pra montar e testar a modlist antes de gerar o manifesto final — é um passo manual de conveniência, não uma integração. E a política de licenciamento (`docs/technical/LICENSE_AND_AFFILIATION_POLICY.md`) já exige verificar permissão de redistribuição mod a mod, exatamente como o Nexus exige pra Collections públicas: o processo de compliance é o mesmo, só o formato de saída muda.

**Decisão:** manter manifestos próprios. Não migrar.

---

## 6. Assinatura do instalador

**Estado: configurado e nunca executado com certificado.** O `electron-builder.json` e o workflow existem; **nenhum instalador assinado foi gerado**, porque não há certificado. O que falta é uma compra e uma decisão de quem opera o servidor — não é código.

Sem assinatura o SmartScreen mostra *"O Windows protegeu o computador"* e esconde o botão de executar atrás de "Mais informações". O launcher é a única porta de entrada do servidor, então "o jogador não instala" significa "o jogador não joga". É o item 3.3 do [QA_REPORT](QA_REPORT_2026-08.md).

### 6.1 Como está configurado

O certificado **não fica no repositório e não fica no `electron-builder.json`**. O electron-builder lê duas variáveis do ambiente por conta própria:

| Variável | O que é |
|---|---|
| `CSC_LINK` | caminho para o `.pfx` **ou** o conteúdo dele em base64 |
| `CSC_KEY_PASSWORD` | senha do `.pfx` |

O que está declarado no `electron-builder.json` é só o que não é segredo:

```json
"signtoolOptions": {
  "timeStampServer": "http://timestamp.digicert.com",
  "rfc3161TimeStampServer": "http://timestamp.digicert.com",
  "signingHashAlgorithms": ["sha256"]
}
```

**O carimbo de tempo não é detalhe.** Sem ele, todo instalador já distribuído vira "assinatura inválida" no dia em que o certificado vencer — inclusive os que os jogadores baixaram meses antes. Com carimbo, a assinatura continua válida porque o Windows consegue provar que ela foi feita enquanto o certificado valia.

> ⚠️ O `electron-builder.json` **não aceita comentário**, nem no formato `"//chave"` que o `package.json` usa neste repositório: o schema declara `additionalProperties: false` e o build falha na validação. Toda explicação de configuração de build mora aqui.

**Sem `CSC_LINK`, o build continua funcionando** e gera o instalador não assinado, com aviso no log. Isso é deliberado: contribuidor e build local não podem depender de um certificado que só quem opera o servidor tem.

### 6.2 O workflow

`.github/workflows/release-launcher.yml`, em `windows-latest` (o `signtool` é do Windows). Dispara por tag `launcher-v*` ou à mão pela aba Actions.

Ele avisa em alto e bom som se o build vai sair assinado, constrói, e então **verifica de verdade** — `Get-AuthenticodeSignature` precisa devolver `Valid` **e** um carimbo de tempo. Se havia certificado e a assinatura não colou, o job falha: um instalador não assinado saindo de um build que deveria assinar é pior que um build quebrado, porque parece que deu certo.

Os segredos esperados no repositório são `WINDOWS_CSC_LINK` e `WINDOWS_CSC_KEY_PASSWORD`.

### 6.3 O que falta, e é decisão humana

**1. Escolher e comprar o certificado.** Três caminhos, e eles não são equivalentes:

| Opção | Custo anual aproximado | SmartScreen | Observação |
|---|---|---|---|
| **OV** (Organization Validation) | US$ 200–400 | Reputação construída ao longo de downloads — **o aviso continua aparecendo no começo** | Desde 2023 exige armazenamento em token físico ou HSM, o que complica CI |
| **EV** (Extended Validation) | US$ 300–600 | Reputação **imediata** | Token físico obrigatório; assinar em CI exige HSM na nuvem |
| **Azure Trusted Signing** | ~US$ 10/mês | Reputação imediata (certificado emitido pela Microsoft) | Nasceu para este caso: sem `.pfx`, sem token, integra com CI. Exige entidade verificada com 3+ anos |

Para um servidor mantido por uma pessoa, o **Azure Trusted Signing** é o caminho que faz mais sentido — é o único dos três que não exige um token USB plugado numa máquina para assinar. O `electron-builder` 26 já o suporta por `win.azureSignOptions`, e trocar para ele significa mexer no `electron-builder.json` e nos segredos, não no workflow.

**Este documento não decide qual comprar.** A escolha depende de a pessoa ter CNPJ com a idade que a Microsoft exige, e de quanto o projeto quer gastar por ano.

**2. Confirmar o SmartScreen na mão.** Isto **não é automatizável** e não está no workflow. Reputação de SmartScreen é construída pela Microsoft ao longo de downloads reais; a única verificação possível é:

1. Baixar o instalador pelo navegador (não `curl` — o SmartScreen reage à marca de origem que o navegador grava no arquivo).
2. Numa máquina Windows limpa, que nunca viu este instalador.
3. Executar e anotar exatamente o que aparece: nada, "Mais informações", ou bloqueio.

Registre o resultado aqui quando acontecer. Enquanto esta seção não tiver esse registro, o item 3.3 do QA continua **aberto**, mesmo com o workflow verde — pela mesma razão que vale para o resto do projeto: *build verde significa que não quebrou o que já era verificado, não que funciona na mão do jogador.*
