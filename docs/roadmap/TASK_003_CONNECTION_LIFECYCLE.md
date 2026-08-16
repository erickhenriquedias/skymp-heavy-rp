# TASK-003 - Ciclo de conexao e whitelist

**Status:** refactor estático concluído; validação online com clientes pendente  
**Dono inicial:** Core / Gamemode  
**Ultima atualizacao:** 2026-08-16

## Problema

O monitor usava polling global com limites hardcoded de `userId` (`1..10`) e
`profileId` (`1..50`), apesar de o pin atual do SkyMP expor eventos nativos
`connect`/`disconnect` e a property nativa `profileId` no Actor. Além de não
enxergar slots/perfis maiores, o custo crescia pelo produto dos dois ranges.

O mesmo callback tratava ator ou profile ainda indisponivel no primeiro polling
como estado final. Nessas condicoes a whitelist nunca era iniciada para aquele
jogador, ate uma nova reconexao.

## Alteracoes

| Local | Mudanca | Motivo |
| --- | --- | --- |
| `core/connection-monitor.js` | Eventos `mp.on('connect'|'disconnect')` com sessão por `userId` e GUID | Impedir que resposta antiga afete uma sessão nova |
| `core/connection-monitor.js` | Retry somente por sessão enquanto ator/profile não foi publicado | Cobrir a janela da engine sem loop global ocioso |
| `core/connection-monitor.js` | `mp.get(actorId, 'profileId')` | Resolver profile em O(1), sem scan `1..N` |
| `core/connection-monitor.js` | Reconciliação única `0..maxPlayers-1` no start | Cobrir hot reload/registro tardio sem limite hardcoded |
| `core/connection-monitor.js` | Limpeza idempotente de personagem e painel | Evitar dupla limpeza em recusa seguida de desconexao |
| `phase0-basic.js` | Usa o monitor como adaptador da API global `mp` | Tirar regra assincrona do arquivo de boot e permitir teste unitario |
| `core/connection-monitor.test.js` | Ator/profile tardio, GUID trocado, reconexão, recusa, slot zero e ranges altos | Fixar lifecycle e escala esperados |

## Contratos preservados

- Não há mais polling global nem limite próprio de slot/profile. O retry de 2 s
  existe somente para sessões conectadas ainda sem ator/profile.
- `mp.getServerSettings().maxPlayers` é usado somente na reconciliação inicial.
- `whitelist.checkWhitelist()` continua sendo a autoridade para aprovar ou
  rejeitar e continua solicitando kick nas recusas conhecidas.
- Em erro tecnico do check, o monitor solicita kick e limpa somente a sessao
  ainda atual.
- O monitor nao importa servicos PARKED nem inicia modulos opcionais.

## Verificacao

- `node --test core/connection-monitor.test.js`: 6 testes aprovados.
- `npm run typecheck`: aprovado sem erros.
- `npm test`: 847 testes, 846 aprovados, 1 ignorado e 0 falhas após os gates de readiness.

## Boot real executado em 2026-08-11

O procedimento `scripts/phase0/Start-Phase0Server.ps1 -Seconds 15` confirmou:

- gamemode `phase0-basic.js` carregado;
- banco inicializado e 4 modulos ativos (`death`, `governance`,
  `market-stalls`, `player-panel`);
- TCP `127.0.0.1:3000` e UDP `127.0.0.1:7777` em escuta;
- nenhum modulo falhou no boot.

O master local em `127.0.0.1:3001` estava desligado, portanto o servidor
registrou `ECONNREFUSED`. Isso nao invalida o smoke test, mas impede confirmar
login online e impede qualquer evidencia CEF sem clientes Skyrim reais.

## Proximo passo

Validar em servidor online três sequências: login normal, ator publicado após o
evento inicial e desconexão/reconexão rápida do mesmo slot. Registrar data,
versão do servidor e resultado; não reintroduzir ranges de polling.
