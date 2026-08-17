# Checklist de Setup do Servidor SkyMP

## 1. Objetivo

Este checklist existe para validar o servidor SkyMP antes de qualquer sistema Heavy RP complexo.

O marco minimo e: servidor rodando, dois clientes conectados, portas documentadas, persistencia definida e comportamento basico testado.

## 2. Ambientes

### Local

- Usado por dev.
- Pode usar `databaseDriver=file`.
- Pode usar hot reload.
- Pode usar DevTools.
- Nunca deve aceitar jogadores publicos.

### Staging

- Usado por staff/testers aprovados.
- Deve simular producao quando possivel.
- Pode ter comandos destrutivos, mas sempre com audit log.
- Hot reload so pode ficar ativo durante janela tecnica.

### Producao

- Usado por jogadores aprovados.
- `offlineMode=false`.
- Hot reload desativado.
- Admin por senha compartilhada proibido.
- DevTools/dev server bloqueados.
- Backups automaticos ativos.

## 3. Arquivos Obrigatorios

Copiar para o `dataDir` do servidor, conforme a versao instalada do Skyrim:

- `Skyrim.esm`
- `Update.esm`
- `Dawnguard.esm`
- `HearthFires.esm`
- `Dragonborn.esm`

Se mods forem usados:

- `.esp` e `.esm` devem estar listados em `loadOrder`.
- `.bsa` deve estar listado em `archives` quando necessario.
- Scripts `.pex` devem estar em `data/scripts` ou no BSA correto.
- Arquivos de UI devem estar em `data/ui` quando servidos pelo SkyMP.

## 4. `server-settings.json`

Campos minimos a revisar:

```json
{
  "name": "Nome do Servidor",
  "masterKey": "chave-do-servidor",
  "listenHost": "0.0.0.0",
  "uiListenHost": "0.0.0.0",
  "port": 7777,
  "maxPlayers": 50,
  "dataDir": "data",
  "loadOrder": [
    "Skyrim.esm",
    "Update.esm",
    "Dawnguard.esm",
    "HearthFires.esm",
    "Dragonborn.esm"
  ],
  "archives": [],
  "lang": "portuguese",
  "locale": "pt-BR",
  "offlineMode": false,
  "databaseDriver": "file",
  "databaseName": "world",
  "gamemodePath": "gamemode/phase0-basic.js",
  "startPoints": [
    {
      "pos": [0, 0, 0],
      "worldOrCell": "0x3c",
      "angleZ": 0
    }
  ],
  "isPapyrusHotReloadEnabled": false
}
```

## 5. Persistencia Nativa SkyMP

### MVP

- Usar `databaseDriver=file` para validar comportamento.
- Fazer backup da pasta `world` antes de cada teste destrutivo.
- Registrar tamanho, tempo de save e comportamento apos restart.

### Producao

- Avaliar `databaseDriver=mongodb`.
- Usar MongoDB separado do MariaDB da plataforma RP, somente se o driver de
  change forms for adotado após testes.
- Criar backup e restore testados antes da beta publica.

### Separacao Obrigatoria

- Estado de mundo SkyMP: driver nativo SkyMP.
- Plataforma RP: MariaDB/MySQL via `mysql2/promise`.
- Cache/fila: Redis opcional.

## 6. Portas

### Porta Principal

- Uso: sincronizacao e trafego principal.
- Protocolo: UDP.
- Padrao: `7777`.
- Deve ser aberta no firewall em staging/producao.

### Porta de UI

- Uso: assets da UI in-game.
- Padrao: `3000` ou `port + 1`.
- Deve ser limitada conforme necessidade.

### Dev Server

- Uso: desenvolvimento de UI.
- Porta comum: `1234`.
- Proibido em producao.

## 7. Flags do Gamemode

O gamemode `phase0-basic.js` deve iniciar com foco em rede, spawn, movimento e persistencia basica.

Servicos avancados ficam desligados por padrao e so devem ser ligados quando o schema e o teste correspondente estiverem prontos.

Estas sao as flags que existem — uma por descriptor registrado em
`phase0-basic.js`. A lista completa e comentada vive em
`skymp/gamemode/.env.example`; copie de la, nao daqui:

```env
PARITY_MANIFEST_PATH=../../apps/game-api/mods.json
MODS_MANIFEST_PUBLIC_KEYS={"release-2026":"COLE_A_CHAVE_PUBLICA_SPKI_BASE64"}
ENABLE_NPC_CLEANER=false
ENABLE_DEATH_SERVICE=false
ENABLE_GOVERNANCE_SERVICE=false
ENABLE_MARKET_STALLS_SERVICE=false
ENABLE_PLAYER_PANEL_SERVICE=false
ENABLE_VOIP_SERVICE=false
```

As duas primeiras variáveis são obrigatórias para o gate de load order. A chave
é pública e deve ser idêntica à da game-api; o manifesto assinado precisa ser o
mesmo servido em `/mods.json`. Divergência entre ele, `server-settings` e
`mp.getEspmLoadOrder()` aborta o boot antes do MariaDB.

> Este bloco listava `ENABLE_JUSTICE_SERVICE`, `ENABLE_SURVIVAL_SERVICE`,
> `ENABLE_FACTION_SERVICE` e `ENABLE_REGIONAL_ECONOMY`, e nao listava
> governanca, barracas nem painel — ou seja, oferecia quatro flags que nao
> ligam nada e escondia tres que ligam. Os tres primeiros servicos foram
> **apagados** em 06/08/2026 (ver [PARKED_SERVICES_DECISION.md](PARKED_SERVICES_DECISION.md));
> `economy-regional` esta PARKED e sem descriptor, entao a flag dele tambem
> nao tem efeito. **Flag sem descriptor no registry nao faz nada** — ver
> `core/module-registry.js` e CONTRIBUTING.md §3.3.

Para laboratorio local com `offlineMode=true`, auto-whitelist de `profileId` 1/2 so pode ser usada com:

```env
ALLOW_LOCAL_AUTOWHITELIST=true
```

Em producao, `NODE_ENV=production` deve impedir auto-whitelist mesmo que a flag seja configurada por engano.

### Chromium DevTools

- Uso: debug local do browser embutido.
- Porta comum: `9000`.
- Proibido em producao.

## 8. Testes Minimos da Fase 0

- Servidor inicia sem erro.
- Servidor aparece no destino esperado.
- Cliente 1 conecta.
- Cliente 2 conecta.
- Dois jogadores se veem.
- Movimento sincroniza.
- Mudanca de celula nao quebra conexao.
- Chat local funciona, se ja existir.
- Morte/respawn basico nao causa crash.
- Reconnect preserva ou recria personagem conforme regra esperada.
- Restart do servidor preserva estado esperado.
- Logs registram conexao, spawn e disconnect.

## 9. Bloqueios de Producao

Producao nao pode abrir enquanto qualquer item abaixo estiver ativo:

- `offlineMode=true`.
- Hot reload ativo.
- Admin por senha compartilhada.
- Comandos destrutivos sem permissao por cargo.
- Comandos destrutivos sem audit log.
- Dev server exposto.
- DevTools exposto.
- `databaseDriver=file` sem backup testado.
- Modlist sem controle de versao.
- Spawn sem checar personagem aprovado.

## 10. Evidencia Esperada

Ao final da Fase 0, registrar:

- Versao do SkyMP.
- Versao do Skyrim.
- Hash/versao da modlist.
- `server-settings.json` usado, sem segredos.
- Portas abertas.
- Driver de persistencia.
- Resultado dos testes.
- Lista de crashes/dessync.
- Decisao: continuar, corrigir ou trocar abordagem.

## 11. Manual de Instalação do Cliente SkyMP (Fase 0)

Para testadores ou desenvolvedores realizando a instalação manual do cliente SkyMP no ambiente local:

### Requisitos Prévios
- **Skyrim Special Edition/Anniversary Edition** instalado (Versão alvo recomendada: `1.6.1170.0`).
- **SKSE64** instalado e funcionando para a versão correspondente do Skyrim.

### Passo 1: Obter o Artefato do Cliente
O artefato do cliente (`dist/client`) é compilado no GitHub Actions e contém a seguinte estrutura sob a pasta `Data/`:
```text
Data/
  Interface/
  Platform/
    Plugins/
      skymp5-client.js
      skymp5-client-settings.txt
  SKSE/
  Scripts/
```

### Passo 2: Copiar os Arquivos
1. Localize a pasta de instalação do seu Skyrim (ex: `D:\SteamLibrary\steamapps\common\Skyrim Special Edition`).
2. Copie o conteúdo da pasta `Data` do artefato do cliente e mescle com a pasta `Data` do seu Skyrim.
3. *Aviso*: Recomenda-se realizar o backup de qualquer arquivo existente em `Data/Platform/Plugins/` antes de sobrescrever.

### Passo 3: Configurar Conexão do Cliente
Edite ou crie o arquivo `Data/Platform/Plugins/skymp5-client-settings.txt` na pasta de instalação do Skyrim com o seguinte formato JSON:
```json
{
  "gameData": {
    "profileId": 1
  },
  "master": "",
  "server-ip": "127.0.0.1",
  "server-master-key": "local-dev-key",
  "server-port": 7777
}
```
- **profileId**: Identificador local para modo offline (usar valores distintos para o Cliente 1 e Cliente 2 nos testes).
- **server-ip**: IP do servidor local (`127.0.0.1`).
- **server-port**: Porta UDP do servidor (padrão `7777`).

### Passo 4: Executar o Jogo
1. Certifique-se de que o servidor local esteja rodando.
2. Inicie o jogo executando o `skse64_loader.exe` na pasta raiz do Skyrim.
3. O mod SkyrimPlatform irá carregar o plugin `skymp5-client.js` e iniciar a conexão automática com o servidor configurado.
