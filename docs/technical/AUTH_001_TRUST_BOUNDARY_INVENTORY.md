# AUTH-001 — Inventário de trust boundaries

Data: 2026-08-12. Fonte: código local, não apenas documentação.

## Cadeia real atual

```text
Discord OAuth code
  -> apps/web troca o code no Discord
  -> accountId + discordId
  -> launch_tickets (hash, uso único, 5 min)
  -> apps/game-api consome launch ticket
  -> poll ticket rotativo da fila
  -> game_sessions (hash, reutilizável para reconnect)
  -> launcher grava skymp5-client-settings.txt.gameData.session
  -> SkyMP com offlineMode=false consulta Master API
  -> Master API retorna user.id = accountId
  -> engine publica profileId = accountId
  -> connection-monitor resolve actorId -> profileId
  -> whitelist resolve account -> approved character
  -> commands cacheia actorId -> accountId/characterId/staff
```

## Identificadores e autoridade

| Dado | Emissor atual | Transporte/persistência | Validador | Consumidor | Autoridade | Risco |
|---|---|---|---|---|---|---|
| Discord OAuth `code` | Discord | launcher -> web HTTPS esperado | Discord token endpoint + redirect allowlist | web | Discord | MEDIUM: interceptação/replay depende de OAuth/PKCE e TLS |
| `discordId` | Discord API | web DB; launcher auth file | web após OAuth | UI/crash metadata | web/Discord | MEDIUM: launcher também possui cópia não autoritativa |
| `accountId` | MariaDB | server-side e Master API response | FK/query server-side | game session/profile | MariaDB | GOOD |
| launch ticket | web CSPRNG | claro só no launcher; hash DB | game-api, TTL + consumed_at | fila | web/game-api | GOOD, se consumo é atômico |
| poll ticket | game-api | memória do main process | game-api, rotacionado | join/status | game-api | MEDIUM: perde estado no restart; nomes ambíguos |
| game session | game-api CSPRNG | claro no launcher/config; hash em MariaDB | Master API, expiry/revoked | SkyMP login/reconnect | web/MariaDB | GOOD/PARTIAL: reutilizável por design, sem bind de personagem/audience explícito |
| `masterKey` | operação | server settings + request path | comparação no web | Master API | operação | HIGH se vazado em logs/URL/proxy |
| `profileId` online | Master API `user.id` | engine runtime | SkyMP quando `offlineMode=false` | connection monitor/whitelist | accountId server-side | GOOD condicionado à config |
| `profileId` client-side | não é escrito pelo launcher online desde AUTH-003 | somente laboratório offline manual | SkyMP somente offline mode | laboratório | CLIENT | removido do fluxo online; `offlineMode=true` continua inseguro fora do laboratório |
| `userId` | SkyMP runtime | memória | engine | connection monitor/kick | engine session slot | EPHEMERAL; reutilizável |
| `actorId` | SkyMP runtime | memória/mp props | engine + monitor | todos os services | engine session actor | EPHEMERAL; limpar no disconnect |
| `characterId` | MariaDB | query por account; cache actor | whitelist | gameplay services | MariaDB | PARTIAL: escolha implícita do approved mais recente |
| staff role | `staff_roles` MariaDB | cache por actorId | admin service | commands/governance | MariaDB | GOOD se cleanup sempre ocorrer |
| VIP | `accounts.vip_level` | DB | services | monetização | MariaDB | não concede staff por design |

## Trust boundaries por componente

### Launcher

Confiável apenas para apresentação e armazenamento temporário. O usuário controla binário, renderer, arquivos e argumentos IPC.

- Pode apresentar OAuth code e tickets, mas não provar identidade sozinho.
- `launch-game` recebe `ticket` pelo IPC; o main process valida e escreve `gameData.session` nas settings oficiais do cliente.
- Remove `gameData.profileId`, `launcherTicket` e `token` legados antes do launch.
- `discordId`, username e crash metadata enviados pelo launcher não podem autorizar nada.

### Web/Master API

É trust boundary de autenticação junto com MariaDB.

- Troca OAuth code mantendo client secret no servidor.
- Emite launch ticket CSPRNG e guarda apenas SHA-256.
- Resolve game session ativa e retorna `accountId` como `user.id`.
- `masterKey` no path é segredo operacional; deve ser redigido e futuramente substituído/complementado por autenticação que não apareça em URL.

### Game API/fila

Transforma launch ticket em admissão e game session. É autoridade temporária de capacidade, não de personagem ou staff.

- Launch ticket precisa ser consumido numa operação atômica no MariaDB.
- Estado de fila/admission atualmente reside em memória; restart muda a disponibilidade, mas não deve mudar identidade.
- Game session deve ser emitida somente após consumo válido e nunca aceitar accountId do cliente.

### SkyMP/gamemode

- Em online mode, profileId vem da resposta do Master API e representa accountId.
- `connection-monitor` procura actor por profileId via polling e evita que uma promise antiga aprove/rejeite uma reconexão nova.
- `whitelist.checkWhitelist` normaliza o `profileId` online para `accountId` e consulta `accounts.id`. `discord_id` continua sendo somente a identidade externa de login.
- Depois da resolução, gameplay deve usar `commands.getActiveCharacterData(actorId)`, nunca characterId/profileId enviado em UI packet.

## Security blockers

### SECURITY-BLOCKER AUTH-01 — profileId redundante controlado pelo cliente (**RESOLVIDO em AUTH-003, 2026-08-16**)

O launcher gravava `gameData.profileId` derivado dos últimos oito dígitos do Discord. AUTH-003 removeu o campo do fluxo online e passou a gravar somente `gameData.session`, consumida pelo patch cliente registrado. O risco de `offlineMode=true` permanece inerente ao modo laboratório.

**Gate:** CI/config doctor reprova `offlineMode=true` fora de ambiente local; `auth-boundary.test.js` impede o launcher de voltar a derivar profileId.

### SECURITY-BLOCKER AUTH-02 — semântica divergente de profileId (**RESOLVIDO em 2026-08-12**)

O Master API retorna `accountId` e a whitelist agora consulta `accounts.id`. Account ID e Discord ID permanecem namespaces separados.

**Evidência:** online `profileId === accountId`; `whitelist.test.js` cobre a consulta por `accounts.id`. Discord ID é atributo, não chave de gameplay.

### SECURITY-BLOCKER AUTH-03 — personagem não vinculado à sessão

Whitelist seleciona `ORDER BY id DESC LIMIT 1` entre personagens aprovados. A sessão autentica conta, mas não fixa slot/personagem. Ao permitir alts, login pode carregar personagem diferente sem uma escolha autoritativa explícita.

**Gate:** CHR-001/002 adiciona seleção/bind server-side; até lá manter cardinalidade efetiva de um approved ativo por conta.

### SECURITY-BLOCKER AUTH-04 — segredo em URL

URLs aparecem com facilidade em access logs, traces e proxies. Duas ocorrências desta classe foram identificadas.

**AUTH-04a — `masterKey` no path do Master API.** Aberto.

**Gate:** redaction imediata em observabilidade e ADR para autenticação por header/mTLS ou chave derivada, preservando compatibilidade SkyMP.

**AUTH-04b — ticket de fila na query string. RESOLVIDO em 2026-08-13.**

`GET /api/queue/status?ticket=…` lia a credencial de `req.query.ticket`, enquanto `POST /api/queue/join`, catorze linhas acima, sempre leu do corpo. Dois tratamentos do mesmo segredo no mesmo arquivo.

Encontrado ao verificar se estávamos expostos ao problema que o `SensitiveArgumentMasker` do Crows RP revela — **não estávamos** por argumento de linha de comando. Desde AUTH-003, a sessão vai em `clientSettings.gameData.session`; o patch também impede o servidor upstream de registrar o bearer em falhas. Ver [`ECOSYSTEM_DEEP_DIVE`](../research/SKYMP_ECOSYSTEM_DEEP_DIVE.md) §10.

Impacto real era menor que o da AUTH-04a: o transporte já é HTTP puro, e o `queue_grant` rotaciona e é de uso único — um ticket que aparecesse num log provavelmente já estaria consumido. O que justificou corrigir foi o custo (não há launcher em produção, porque a Fase 0 nunca rodou) e a inconsistência, que convidava o próximo endpoint a copiar o lado errado.

Correção: a rota virou `POST /api/queue/status` lendo `(req.body || {}).ticket`; `req.query` é ignorado. `poll-queue` no launcher passou a usar `postJsonToUrl`, igual ao `join-queue`.

**Regressão travada por teste.** `apps/game-api/server.http.test.js` — primeiro teste em nível HTTP deste serviço, criado junto. Exige 404 no `GET /api/queue/status` e 401 quando o ticket vem só pela query. Verificado por mutação: revertendo `app.post` para `app.get`, nove testes falham.

## Caracterizações que viram testes/gates

1. Master API retorna `accountId` e nunca aceita ID do cliente.
2. Sessão revogada/expirada/desconhecida retorna 404.
3. Banco guarda somente hashes de launch/game tickets.
4. Resposta obsoleta de whitelist não toca uma reconexão.
5. Configuração staging/production deve ter `offlineMode=false`.
6. Launcher online remove profileId/launcherTicket/token legados e o contract test prova `AuthGameData.remote`.
7. Staff role é resolvido por accountId server-side e removido no disconnect.
8. Nenhuma credencial viaja em query string ou path — coberto para a fila por `server.http.test.js` (AUTH-04b); o `masterKey` (AUTH-04a) segue descoberto.

## Decisão para AUTH-002

Não criar um único token para todas as funções. Manter três capabilities:

- `launch_grant`: uso único, OAuth -> fila;
- `queue_grant`: rotativo, somente polling/admissão;
- `game_session`: reconnect permitido, somente Master API/SkyMP.

O contrato v1 formaliza nomes, audience e lifecycle. Character bind será opcional no schema v1 e obrigatório quando CHR-002 for ativado.
