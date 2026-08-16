# Matriz de teste — plataforma do launcher

Data: **2026-08-13**. Cobre `apps/launcher`, `apps/game-api` e o caminho de `apps/web` que o launcher usa.

Deriva de [`PLATFORM_INFRASTRUCTURE_AUDIT.md`](../research/PLATFORM_INFRASTRUCTURE_AUDIT.md). Onde um cenário testa um achado, o ID (`PLAT-nn`) está na linha.

> **O que uma matriz verde significa aqui.** O mesmo que em todo o resto do repositório: *não quebrou o que já era verificado*. Não significa que funciona na mão do jogador — ver [`QA_REPORT_2026-08.md`](../technical/QA_REPORT_2026-08.md). A coluna **Como** existe justamente para separar o que uma suíte prova do que só uma máquina com Skyrim instalado prova.

---

## 1. Legenda

**Estado**
`✅` coberto hoje · `⚠️` parcial · `❌` sem cobertura · `➖` não aplicável até o sistema existir

**Como**
`unit` — `node --test`, sem rede, sem disco, sem banco
`http` — servidor efêmero, como `apps/game-api/server.http.test.js`
`integração` — exige MySQL
`manual` — exige Windows com Skyrim instalado; **não automatizável**

**Convenção de rigor do projeto:** todo teste marcado `✅` deve ter sido verificado por mutação — quebre a implementação de propósito e confirme que o teste falha. Um teste que passa nos dois estados não testa nada.

---

## 2. Instalação limpa

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 2.1 | Primeira execução sem `launcher-config.json` | Abre em Login, não quebra | manual | ❌ |
| 2.2 | Pasta do jogo nunca configurada, clique em JOGAR | Redireciona pra Configurações com mensagem, não erro genérico | manual | ❌ |
| 2.3 | Pasta sem `SkyrimSE.exe` | `{ ok: false, reason: 'no-skyrim' }` | unit | ❌ (`validateGamePath` não é testado) |
| 2.4 | Pasta do GOG (`Galaxy64.dll` ou `goggame-*.info`) | `reason: 'gog'`, entrada bloqueada | unit | ❌ |
| 2.5 | Skyrim AE não-downgradeado (build ≠ 1.6.1170) | **Deveria** bloquear. Hoje **passa** | manual | ❌ `PLAT-26` |
| 2.6 | `Data/` ausente | Mensagem específica, não exceção crua | unit | ❌ |
| 2.7 | `SkyrimPrefs.ini` inexistente | `ensure-skyrim-ini` cria com resolução detectada | manual | ❌ |

2.3, 2.4 e 2.6 são o mesmo trabalho: extrair `validateGamePath` do `main.ts` para um módulo puro, como já foi feito com `parity.mjs`. É o padrão que o repositório já adotou e a razão está escrita no cabeçalho daquele arquivo — lógica dentro de `ipcMain.handle` é lógica que não tem como ser testada.

2.5 depende de implementar a verificação, que não existe.

---

## 3. Atualização

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 3.1 | Manifesto de cliente com `clientVersion` novo | `updateAvailable: true` | unit | ❌ |
| 3.2 | Carimbo local igual ao manifesto | `updateAvailable: false`, sem download | unit | ❌ |
| 3.3 | Manifesto **sem** `sha256` | Aborta, **não instala** | unit | ❌ (comportamento existe, `main.ts:1034`) |
| 3.4 | `sha256` não confere | Aborta, apaga o temporário, não extrai | unit | ❌ |
| 3.5 | Download interrompido no meio | Falha limpa; próxima tentativa recomeça | integração | ❌ |
| 3.6 | Modpack em partes, uma parte com `contentSig` igual | Parte pulada, `skipped` incrementa | unit | ❌ |
| 3.7 | Jogo aberto durante a atualização | `gameRunning: true`, recusa antes de baixar | manual | ❌ |
| 3.8 | Extração falha no meio | Carimbo **não** é escrito; próxima tentativa refaz | unit | ❌ |
| 3.9 | `/mods.json` com `manifestVersion` maior que o conhecido | `manifest_unsupported_version`, não ignora campos | unit | ✅ contrato compartilhado v1 |
| 3.10 | Manifesto de `development` servido na URL de `stable` | Recusa por divergência de canal | unit | ➖ `PLAT-21` |
| 3.11 | Jogador nunca abre Configurações | **Deveria** atualizar no fluxo de jogar. Hoje **não atualiza** | manual | ❌ `PLAT-01` |

3.3 e 3.4 são os testes mais importantes desta seção e os mais baratos: o comportamento correto já está implementado e não tem nada que o proteja de uma regressão. São exatamente o caso em que um teste vale porque a lógica está certa **hoje**.

3.9 está coberto no loader. O campo `channel` agora existe e aceita somente
valores conhecidos, mas 3.10 continua pendente porque ainda não há URLs/canais
separados para comparar o canal recebido com o canal solicitado (`PLAT-21`).

---

## 4. Integridade e paridade

Onde a cobertura atual é boa. `parity.test.mjs` já cobre o núcleo.

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 4.1 | Arquivo do manifesto ausente em `Data/` | `Mod faltando: X` | unit | ✅ |
| 4.2 | Arquivo presente com hash diferente | `esta modificado ou corrompido` | unit | ✅ |
| 4.3 | Diferença de caixa no nome (Windows) | Casa mesmo assim | unit | ✅ |
| 4.4 | Plugin da ordem do servidor ausente | `Plugin ausente: X` | unit | ✅ |
| 4.5 | Master carregando depois do dependente | Reprovado | unit | ✅ |
| 4.6 | Plugin extra ativo no `plugins.txt` | Reprovado, com a explicação de FormID | unit | ✅ |
| 4.7 | Servidor não informa load order | Reprova; **não** cai pra ordem local | unit | ✅ |
| 4.8 | CC ativo no `Skyrim.ccc` fora da ordem do servidor | Reprovado | unit | ✅ |
| 4.9 | CC exigido pelo servidor e ausente no cliente | Reprovado | unit | ✅ |
| 4.10 | Cabeçalho TES4 inválido / arquivo truncado | Erro nomeado, sem exceção | unit | ✅ |
| 4.11 | **BSA extra** em `Data/`, fora do manifesto | Depende de `extraFilePolicy` | unit | ❌ `PLAT-11` |
| 4.12 | BSA acima de 2 GB | Hasheia por stream, sem estourar memória | integração | ⚠️ stream unitário aprovado; arquivo real pendente |
| 4.13 | `verify-mods` com N divergências | Relata **todas**, não a primeira | unit | ✅ `PLAT-05` |
| 4.14 | `/mods.json` responde 503 | Launcher **não** aprova; mensagem específica | http | ⚠️ (503 testado no servidor; reação do launcher não) |
| 4.15 | Manifesto vazio (`mods: []`, `loadOrder: []`) | Recusado na origem, nunca servido | unit | ❌ `PLAT-27` — é **servido com 200** |
| 4.16 | Manifesto com `mods: []` e `loadOrder` preenchida | Conteúdo não verificado; ordem sim | unit | ⚠️ comportamento deliberado (`--only-load-order`) |

4.15 é o achado que a escrita desta matriz produziu, e vale abrir. `modsManifest.js:20-28` documenta no cabeçalho que existe para impedir que uma lista vazia passe na verificação de paridade — mas `isValidManifest({ mods: [], loadOrder: [] })` devolve **`true`** (`[].every()` é `true`), e `modsManifest.test.js:33` registra isso explicitamente: *"aceita manifesto vazio na forma, mas o loader trata o resto"*. **O loader não trata o resto.** `load()` não faz nenhuma checagem além de `isValidManifest`, e `/mods.json` serve o manifesto vazio com 200.

O que de fato barra o jogador é outro módulo, do lado do cliente: `analyzePlugins` recusa `serverLoadOrder` vazia (`parity.mjs:165-171`). A proteção existe e funciona — mas está no lugar errado, num processo que roda na máquina do jogador, e o documento e o teste dizem que está no servidor. Ver `PLAT-27` na auditoria.

---

## 5. Repair

Tudo `➖`: o modo não existe (`PLAT-02`). A matriz fica escrita para quando existir.

| # | Cenário | Espera-se | Como |
|---|---|---|---|
| 5.1 | Um arquivo ausente | Baixa só ele | integração |
| 5.2 | Um arquivo corrompido | Substitui só ele, via staging | integração |
| 5.3 | Arquivo `manual-install` ausente | **Não baixa**; instrui e bloqueia | unit |
| 5.4 | Arquivo extra inesperado | Quarentena, nunca apagar | unit |
| 5.5 | Repair acima do limiar de volume | Pergunta antes de baixar | manual |
| 5.6 | Falha no meio do repair | Estado anterior preservado (backup) | integração |
| 5.7 | Repair de arquivo em uso pelo jogo | Recusa com `gameRunning` antes de tocar disco | manual |
| 5.8 | Repair completo (`--full`) | Equivale ao `force` de hoje | integração |

---

## 6. Manifesto malformado e adversário

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 6.1 | `mods.json` com JSON inválido | 503 com `manifest_invalid_json` | unit | ✅ |
| 6.2 | `mods.json` com forma errada | 503 com `manifest_invalid_shape` | unit | ✅ |
| 6.3 | Arquivo ausente no disco | 503 com `manifest_missing` | unit | ✅ |
| 6.4 | Manifesto trocado com `mtime` novo | Cache invalidado, relê | unit | ✅ |
| 6.5 | `path` com `..` | **Manifesto inteiro** recusado, não só a entrada | unit | ➖ `PLAT-07` |
| 6.6 | `path` absoluto ou com drive (`C:`) | Idem | unit | ➖ |
| 6.7 | `path` com nome reservado do Windows (`CON`, `NUL`, `COM1`) | Idem | unit | ➖ |
| 6.8 | ZIP contendo `../../Windows/…` | Extração recusa | unit | ✅ ZIP hostil real |
| 6.9 | ZIP com symlink/junction apontando pra fora | Extração recusa | manual | ❌ |
| 6.10 | `downloadUrl` para host fora da allowlist | Download recusado | unit | ✅ política compartilhada |
| 6.11 | Redirecionamento para host não autorizado | Recusado | unit | ✅ política reaplicada por salto |
| 6.12 | Feed de manifesto servido por HTTP | Recusado | unit | ✅ somente HTTPS |
| 6.13 | `downloadUrl` com `manual-install` | Gerador **recusa produzir** o manifesto | unit | ➖ (política §3) |
| 6.14 | Gerar manifesto em path privado do operador | JSON não contém `sourceDataDir` | unit | ✅ |

6.8 é a linha mais importante da matriz inteira. É automatizável sem Skyrim e sem rede: monte um ZIP com uma entrada `../x`, chame `extractZip` num diretório temporário, e verifique que nada foi escrito fora dele. **O teste pode ser escrito antes da correção** — ele falha, e é essa falha que documenta o problema.

---

## 7. Backend indisponível

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 7.1 | `game-api` fora do ar, clique em JOGAR | `connection_failed` com texto útil | http | ⚠️ |
| 7.2 | Painel fora do ar durante o login | Erro nomeado, não janela pendurada | manual | ❌ |
| 7.3 | MySQL fora do ar | `/ready` responde **503**; `/health` continua 200 | http | ⚠️ unit/HTTP; falta MariaDB real `PLAT-18` |
| 7.4 | MySQL fora do ar, jogador tenta entrar | `internal_error` — e `/ready` explica por quê | integração | ⚠️ |
| 7.5 | Timeout do feed de update | Falha em 20 s (já implementado), sem travar a UI | unit | ❌ |
| 7.6 | Servidor em manutenção | `/status` devolve `maintenance` + mensagem; launcher mostra e bloqueia JOGAR | unit/http | ⚠️ código aprovado; falta launcher empacotado `PLAT-20` |
| 7.7 | Servidor cheio | `/status` devolve `full`; JOGAR vira "ENTRAR NA FILA" | unit/http | ⚠️ código aprovado; falta launcher empacotado |

---

## 8. Fila

Cobertura atual: `queue.test.js`, 13 testes em 6 suítes, todos em memória. Verificado com `node --test`.

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 8.1 | Slot livre | Admite direto com ticket | unit | ✅ |
| 8.2 | Capacidade cheia | Enfileira, posição correta | unit | ✅ |
| 8.3 | Ordem de chegada | FIFO respeitado | unit | ✅ |
| 8.4 | `join` repetido (polling) | Mesmo ticket, não slot novo | unit | ✅ |
| 8.5 | `join` repetido de quem está na fila | Não duplica posição | unit | ✅ |
| 8.6 | `release` | Promove o próximo | unit | ✅ |
| 8.7 | `release` de quem não está admitido | Não promove errado | unit | ✅ |
| 8.8 | Reserva expira sem conectar | Slot volta pra fila | unit | ✅ |
| 8.9 | Quem conectou não perde slot por tempo | Mantém | unit | ✅ |
| 8.10 | Ticket de sessão válido | Resolve e marca conectado | unit | ✅ |
| 8.11 | Ticket desconhecido | Não resolve | unit | ✅ |
| 8.12 | Ticket após `release` | Deixa de resolver | unit | ✅ |
| 8.13 | Conta que nunca entrou | `not_queued` | unit | ✅ |
| 8.14 | **Dois launchers, mesmo `auth.json`** | Um entra; o outro recebe erro **explicável**, não `invalid_ticket` cru | integração | ❌ |
| 8.15 | Recuperação de ocupação após restart | Conectados e reservas recentes voltam antes da porta abrir | unit | ✅ `PLAT-13` |
| 8.16 | Corrida de capacidade | Não existe dentro da fila (síncrona, monothread) | — | ➖ |
| 8.17 | Retenção de `launch_tickets` e `game_sessions` | Cortes distintos, lotes limitados e execução não concorrente | unit | ✅ `PLAT-16` |
| 8.18 | Rate limiter compartilhado recebe 10.000 chamadas bloqueadas da mesma chave | Bucket não ultrapassa o limite configurado | unit | ✅ `PLAT-17` |
| 8.19 | Flood de IPs distintos contra game-api, painel e bot | Buckets e heap ficam limitados; excesso recebe 429 sem degradar tráfego legítimo | carga | ❌ operacional |
| 8.20 | Backlog superior a 5.000 credenciais vencidas no MariaDB | Remove por rodadas, preserva válidas e usa índices de expiração | integração | ❌ operacional `PLAT-16` |
| 8.21 | **Restart da game-api com dois clientes reais dentro** | Ocupação não volta a zero e ninguém novo excede a capacidade | integração | ❌ operacional `PLAT-13` |

8.16 fica registrado como `➖` de propósito: a §13 do briefing pede o cenário,
e a resposta honesta é que ele não existe dentro da estrutura síncrona. A
fronteira memória/MariaDB do restart possui cobertura unitária em 8.15; sua
prova com processos e clientes reais permanece em 8.21.

8.14 vale ser desdobrado, porque o comportamento é o correto e a mensagem é o problema: o `launchTicket` é de uso único, então o segundo launcher perde a corrida por desenho. O que falta é o erro dizer isso ("outro launcher já está usando esta conta") em vez de `invalid_ticket`.

---

## 9. Tickets e sessões

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 9.1 | Ticket ausente / vazio / curto | 401 antes de tocar o banco | http | ✅ |
| 9.2 | Ticket na query string | Ignorado; mesma resposta de não mandar nada | http | ✅ |
| 9.3 | `GET /api/queue/status` | Não existe mais | http | ✅ |
| 9.4 | `/internal/*` sem `X-Internal-Secret` | 401 | http | ✅ |
| 9.5 | Ticket válido, conta elegível | Admite e persiste sessão | integração | ❌ (caminho feliz, declarado no rodapé de `server.http.test.js`) |
| 9.6 | Ticket já consumido | 401 | integração | ❌ |
| 9.7 | Ticket expirado (>5 min) | 401 | integração | ❌ |
| 9.8 | Mesmo ticket, dois pedidos simultâneos | Exatamente um `affectedRows === 1` | integração | ❌ |
| 9.9 | Conta banida entre login e fila | `account_not_active` | integração | ❌ |
| 9.10 | Conta sem whitelist aprovada | `not_whitelisted` | integração | ❌ |
| 9.11 | Conta sem personagem aprovado | `no_approved_character` | integração | ❌ |
| 9.12 | Sessão resolvida no master | `{ user: { id } }`, `resolve_count` incrementa | integração | ⚠️ (`apps/web/server.test.js` verifica o SQL) |
| 9.13 | Sessão revogada | Master recusa | integração | ⚠️ (SQL e lease verificados em unit; falta MariaDB real — `PLAT-14`) |
| 9.14 | Sessão expirada (>12 h) | Master recusa | integração | ❌ |
| 9.15 | **Mesma sessão resolvida de dois IPs** | Exatamente um consumo vence; o outro recebe 404 | integração | ⚠️ corrida SQL verificada; falta MariaDB real `PLAT-15` |
| 9.16 | `release` revoga a conexão exata | `revoked_at`/`disconnected_at` só na linha do lease; replay é no-op | integração | ⚠️ unit; falta MariaDB real `PLAT-14` |
| 9.17 | Master confirma ocupação na game-api | Reserva vira conexão e não expira em 3 min | http/unit | ✅ `PLAT-13` |
| 9.18 | Game-api indisponível durante resolução master | Login recebe 503; mesmo token fica consumido e sessão nova converge | integração | ❌ operacional `PLAT-13/15` |
| 9.19 | Disconnect antigo após reconnect | Lease antigo não revoga nem libera a conexão nova | integração | ⚠️ unit; falta dois clientes reais `PLAT-14` |
| 9.20 | Dois clientes na mesma conta | Novo lease expulsa o Actor anterior; cleanup antigo não derruba o novo | integração | ⚠️ unit; falta dois clientes reais `PLAT-14/15` |

9.8 é o teste que prova a propriedade central de segurança deste sistema — uso único sob concorrência — e é o único da seção que **não pode** ser substituído por leitura de código. Duas conexões, mesmo ticket, contar quantos passam. Exige banco.

O bloco 9.5–9.11 é uma dívida única: **não há harness de integração com MariaDB neste repositório.** Enquanto não houver, toda a coluna fica `❌`, e nenhum trabalho por linha resolve. Montá-lo (instância efêmera de MariaDB, migrations aplicadas, dados semeados) destrava 12 linhas desta matriz de uma vez, e é o item de maior alavancagem daqui.

---

## 10. Mudança de modpack

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 10.1 | Servidor publica modpack novo com jogadores dentro | Quem está jogando não cai; quem entra depois usa o novo | manual | ❌ |
| 10.2 | Load order muda de ordem, mesmos arquivos | Clientes com a ordem antiga são reprovados | unit | ✅ (4.6 cobre o mecanismo) |
| 10.3 | Manifesto regenerado com `--only-load-order` | Cobre menos arquivos e o documento diz isso | unit | ✅ |
| 10.4 | Manifesto gerado sem `--plugins-txt` | Avisa alto que a ordem é alfabética e não confiável | unit | ✅ |
| 10.5 | Load order com plugin que não existe em `Data/` | Gerador falha, não publica | unit | ✅ |
| 10.6 | `build` muda; cliente antigo tenta entrar | **Servidor** deveria recusar | integração | ➖ `MOD-006` |

10.6 é a única linha desta matriz que testa uma defesa **server-side**. Todas as outras testam o launcher — e um launcher modificado pula todas elas. Isso não é falha desta matriz; é a razão pela qual `MOD-006` existe no roadmap.

---

## 11. Onde investir primeiro

Ordenado por (valor × facilidade), não por severidade:

| Ordem | O quê | Destrava | Custo |
|---|---|---|---|
| 1 | Recusar manifesto vazio no loader + teste (4.15) | `PLAT-27` — a maior gravidade pelo menor custo | Trivial — três linhas |
| 2 | Teste de zip slip (6.8) | Documenta `PLAT-07` antes de corrigi-lo | Baixo — nada de rede, nada de Skyrim |
| 3 | Extrair `validateGamePath` para módulo puro | 2.3, 2.4, 2.6 | Baixo — o padrão do `parity.mjs` já existe |
| 4 | Testes de manifesto sem `sha256` (3.3, 3.4) | Protege comportamento **já correto** de regressão | Baixo |
| 5 | Harness de integração com MySQL | 12 linhas da §9 de uma vez | Médio, e é o maior salto |
| 6 | `/ready` + teste (7.3) | ✅ implementado; falta apenas MariaDB real | Concluído no código |

Os cinco primeiros não exigem decisão de produto nenhuma e não dependem da Fase 0. O sexto é a menor unidade útil de trabalho de operação.

---

## 12. O que esta matriz não cobre

- **Nada in-game.** Onde o launcher entrega o controle ao SKSE, esta matriz acaba.
- **Nenhum caso é executável hoje sem escrever o teste.** As linhas `❌` são lacunas, não falhas registradas — nenhuma foi observada, todas foram deduzidas do código.
- **SmartScreen e assinatura** continuam em [`LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) §6.3, e continuam não automatizáveis.
- **Nenhuma sessão real.** Como todo o repositório.
