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
| 2.3 | Pasta sem `SkyrimSE.exe` | `{ ok: false, reason: 'no-skyrim' }` | unit | ✅ |
| 2.4 | Pasta GOG, mesmo com DLL Steam copiada | `reason: 'gog'`, entrada bloqueada | unit | ✅ |
| 2.5 | Versão diferente de Steam 1.6.1170.0 | `unsupported-version`, bloqueia save/update/repair/rollback/launch | unit/manual | ⚠️ unit aprovado; Skyrim real pendente |
| 2.6 | `steam_api64.dll` ou `Data/` ausente | `not-steam`/`no-data`, mensagem específica | unit | ✅ |
| 2.7 | `SkyrimPrefs.ini` inexistente | `ensure-skyrim-ini` cria com resolução detectada | manual | ❌ |

2.3–2.6 usam `game-installation.mjs`. A leitura real do `FileVersion` é feita
pelo processo principal via `FileVersionInfo`, com o path em variável de
ambiente para não interpolar entrada em comando. Falta exercitar o executável
real do Skyrim Steam no launcher empacotado.

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
| 3.9 | `/mods.json` com `manifestVersion` maior que o conhecido | `manifest_unsupported_version`, não ignora campos | unit | ✅ contrato compartilhado v2 |
| 3.10 | Manifesto de `development` servido na URL de `stable` | Recusa por divergência de canal | unit | ✅ `PLAT-21` |
| 3.11 | Jogador nunca abre Configurações | JOGAR consulta os dois feeds e bloqueia versão antiga | unit/manual | ⚠️ decisão unitária aprovada; falta empacotado `PLAT-01` |
| 3.12 | Envelope Ed25519 válido | Payload liberado e digest de release calculado | unit | ✅ |
| 3.13 | Payload/signature adulterado ou chave errada | Recusa antes do download | unit | ✅ |
| 3.14 | `sequence` menor que o maior aceito | Recusa downgrade mesmo após rollback local | unit | ✅ |
| 3.15 | Mesmo `sequence`, conteúdo diferente | Recusa reuso; replay idêntico continua possível | unit | ✅ |
| 3.16 | Manifesto expirado ou muito no futuro | Recusa fora da tolerância de relógio | unit | ✅ |
| 3.17 | Rotação/revogação real de chave | Sobreposição aceita ambas; launcher novo recusa a removida | release/manual | ❌ |
| 3.18 | Dois launchers persistem high-watermark juntos | Lock impede lost update; lock órfão recupera | unit/integração | ⚠️ unit aprovado; falta dois processos reais |
| 3.19 | Renderer chama fila/launch sem preparação | Processo principal recusa sem consumir ticket | unit/manual | ⚠️ store unitário aprovado; falta IPC empacotado |
| 3.20 | Recibo de outra conta/path, expirado ou repetido | Recusa; recibo válido é consumido uma vez | unit | ✅ |
| 3.21 | Cancelar update durante download/verificação | Aborta transporte, descarta staging e não publica carimbo | unit/manual | ⚠️ coordenador unitário aprovado; transporte empacotado pendente |
| 3.22 | Cancelar durante commit | Recusa cancelamento e conclui/recupera pelo journal | unit/manual | ⚠️ regra unitária aprovada; filesystem real pendente |

3.3 e 3.4 são os testes mais importantes desta seção e os mais baratos: o comportamento correto já está implementado e não tem nada que o proteja de uma regressão. São exatamente o caso em que um teste vale porque a lógica está certa **hoje**.

3.9 está coberto no loader. Cliente, modpack e paridade agora exigem `channel`
assinado igual ao canal fixado no build. `stable` preserva as URLs existentes;
`beta` e `development` usam tags próprias, e cada tipo+canal mantém seu próprio
high-watermark anti-downgrade.

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
| 4.11 | **BSA extra** em `Data/`, fora do manifesto | `reject`, `warn` ou `ignore` conforme contrato; nunca apagar | unit | ✅ contrato; runtime pendente |
| 4.12 | BSA acima de 2 GB | Hasheia por stream, sem estourar memória | integração | ⚠️ stream unitário aprovado; arquivo real pendente |
| 4.13 | `verify-mods` com N divergências | Relata **todas**, não a primeira | unit | ✅ `PLAT-05` |
| 4.14 | `/mods.json` responde 503 | Launcher **não** aprova; mensagem específica | http | ⚠️ (503 testado no servidor; reação do launcher não) |
| 4.15 | Manifesto vazio (`files: []`, `loadOrder: []`) | Recusado na origem, nunca servido | unit | ✅ contrato v2 |
| 4.16 | `--only-load-order` | Só plugins ativos entram em `files`; ainda não aceita lista vazia | unit | ✅ |
| 4.17 | JS do Skyrim Platform, SWF/CSS, NIF/DDS/HKX/FUZ ou arquivo sem extensão alterado/extra | Participa da paridade como `script`/`asset`; política de extras é aplicada | unit/real | ⚠️ enumeração e geração aprovadas; `Data/` real pendente |
| 4.18 | Launcher injeta nova sessão em `skymp5-client-settings.txt` | Path exato assinado é ignorado; demais arquivos continuam protegidos | unit/empacotado | ⚠️ contrato, gerador e classificação do launcher aprovados; dois launches reais pendentes |
| 4.19 | `ignoredPaths` com travessia, duplicação case-insensitive ou colisão com `files` | Manifesto inteiro recusado | unit | ✅ |

O antigo `PLAT-27` foi fechado pelo contrato v2 compartilhado: `files` e
`loadOrder` vazios são rejeitados no gerador, game-api e launcher.

---

## 5. Repair

O repair incremental v2 está implementado no fluxo de JOGAR e reutiliza a
instalação transacional. A cobertura unitária valida o plano e a recusa de
junction; rede, filesystem adverso e launcher empacotado continuam pendentes.

| # | Cenário | Espera-se | Como |
|---|---|---|---|
| 5.1 | Um arquivo ausente | Baixa só ele | integração |
| 5.2 | Um arquivo corrompido | Substitui só ele, via staging | integração |
| 5.3 | Arquivo sem URL ausente | **Não baixa**; instrui e bloqueia | unit |
| 5.4 | Arquivo extra inesperado | Recusa e instrui; nunca apaga (quarentena futura) | unit/manual |
| 5.5 | Repair acima de 500 MB | Pergunta antes de baixar | manual |
| 5.6 | Falha no meio do repair | Estado anterior preservado (backup) | integração |
| 5.7 | Repair de arquivo em uso pelo jogo | Recusa com `gameRunning` antes de tocar disco | manual |
| 5.8 | Repair completo (`--full`) | Rebaixa todas as partes, mesmo com `contentSig` igual | integração — código pronto; runtime pendente |
| 5.9 | Cancelar repair durante arquivo parcial | Fecha request, descarta arquivo/staging e mantém live | integração — pendente |
| 5.10 | Cancelar após hash/extração e antes do commit | Não publica; operação seguinte pode começar normalmente | integração — pendente |

---

## 6. Manifesto malformado e adversário

| # | Cenário | Espera-se | Como | Estado |
|---|---|---|---|---|
| 6.1 | `mods.json` com JSON inválido | 503 com `manifest_invalid_json` | unit | ✅ |
| 6.2 | `mods.json` com forma errada | 503 com `manifest_invalid_shape` | unit | ✅ |
| 6.3 | Arquivo ausente no disco | 503 com `manifest_missing` | unit | ✅ |
| 6.4 | Manifesto trocado com `mtime` novo | Cache invalidado, relê | unit | ✅ |
| 6.5 | `path` com `..` | **Manifesto inteiro** recusado, não só a entrada | unit | ✅ |
| 6.6 | `path` absoluto ou com drive (`C:`) | Idem | unit | ✅ |
| 6.7 | `path` com nome reservado do Windows (`CON`, `NUL`, `COM1`) | Idem | unit | ✅ |
| 6.8 | ZIP contendo `../../Windows/…` | Extração recusa | unit | ✅ ZIP hostil real |
| 6.9 | ZIP com symlink/junction apontando pra fora | Extração recusa | manual | ❌ |
| 6.10 | `downloadUrl` para host fora da allowlist | Download recusado | unit | ✅ política compartilhada |
| 6.11 | Redirecionamento para host não autorizado | Recusado | unit | ✅ política reaplicada por salto |
| 6.12 | Feed de manifesto servido por HTTP | Recusado | unit | ✅ somente HTTPS |
| 6.13 | Arquivo não redistribuível | Sem `url`; paridade verifica, repair orienta instalação manual | unit | ✅ |
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
| 10.6 | Ordem efetiva/configurada do servidor diverge do manifesto assinado | Boot aborta antes do banco/runtime, nomeando índice divergente | unit/SkyMP | ⚠️ gate unitário aprovado; runtime real pendente (`MOD-006`) |

10.6 protege o servidor contra configuração/load order incorreta e garante que
o manifesto servido representa a ordem efetiva. Ele não prova os arquivos do
jogador contra um launcher deliberadamente modificado; cliente não é raiz de
confiança e nenhum campo adicional enviado por ele mudaria isso.

---

## 11. Onde investir primeiro

Ordenado por (valor × facilidade), não por severidade:

| Ordem | O quê | Destrava | Custo |
|---|---|---|---|
| 1 | Extrair testes puros do update de cliente/mods | 3.1–3.8 | Médio |
| 2 | Exercitar Steam 1.6.1170.0 real no launcher empacotado | `PLAT-26` | Baixo/manual |
| 3 | Harness HTTP cancelável com resposta truncada/oversize | 3.5, 3.21 e 5.9 | Médio |
| 4 | Dois processos reais contra a mesma pasta | 3.18 e rollback | Médio |
| 5 | Harness de integração com MariaDB | §9 | Médio |
| 6 | Certificado e SmartScreen em máquina limpa | release pública | Externo |

Os quatro primeiros não exigem decisão de produto. MariaDB, certificado e
SmartScreen dependem do ambiente operacional.

---

## 12. O que esta matriz não cobre

- **Nada in-game.** Onde o launcher entrega o controle ao SKSE, esta matriz acaba.
- **Nenhum caso é executável hoje sem escrever o teste.** As linhas `❌` são lacunas, não falhas registradas — nenhuma foi observada, todas foram deduzidas do código.
- **SmartScreen e assinatura** continuam em [`LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) §6.3, e continuam não automatizáveis.
- **Nenhuma sessão real.** Como todo o repositório.
