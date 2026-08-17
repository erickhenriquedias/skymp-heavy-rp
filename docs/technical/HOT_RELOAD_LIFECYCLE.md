# Hot reload do gamemode

**Estado em 16/08/2026:** lifecycle implementado e coberto por harness; validação
com o processo SkyMP e jogadores reais continua pendente.

## Contrato confirmado no pin

No commit `d85f18d808f877401c4e20484d2c2f6f73cf9caa`, o loader do SkyMP:

1. observa somente o caminho configurado em `gamemodePath`;
2. chama `server.clear()`;
3. copia o entrypoint para um diretório temporário;
4. executa `require()` nessa cópia.

Isso evita o cache apenas para o entrypoint. Dependências carregadas por caminho
absoluto, como `database.js`, `commands.js` e `core/module-registry.js`, continuam
no cache CommonJS.

## Implementação local

`core/runtime-lifecycle.js` é intencionalmente um singleton em cache. Cada nova
cópia de `phase0-basic.js` pede `replace(startInstance)`. A fila executa:

1. shutdown idempotente da instância anterior;
2. fechamento do monitor, timers, hooks, módulos, WebSockets e pool MariaDB;
3. limpeza dos descritores encerrados do module registry;
4. registro dos módulos da nova instância;
5. boot, migrations, readiness e reconstrução do runtime;
6. reconciliação única dos jogadores que continuam conectados.

`SIGINT` e `SIGTERM` pertencem ao singleton, não ao entrypoint temporário. Assim,
recarregar dez vezes não instala vinte listeners de processo.

Módulo que falha depois de abrir recurso no `initialize()` agora recebe
`shutdown()` mesmo sem ter alcançado `RUNNING`. Os hooks próprios de morte, hit,
UI e a assinatura de disconnect do trade também são removidos somente quando
ainda pertencem à instância que está saindo.

## Limites

- Hot reload do pin observa o entrypoint. Alterar apenas um arquivo dependente
  não garante recarregar seu código; para mudança de produção, use restart.
- `mp.on` não oferece unsubscribe no contrato do gamemode. O monitor antigo é
  marcado inativo, mas a remoção nativa dos listeners depende de `server.clear()`.
- O harness prova dez trocas serializadas, uma instância ativa, sinais únicos,
  boot falho e reinício. Ele não reproduz o addon nativo nem jogadores reais.
- `DEBUG_HOT_RELOAD` continua proibido em produção até o protocolo real abaixo
  passar integralmente.

## Protocolo real pendente

Com `offlineMode=true` apenas no laboratório:

1. conectar dois clientes e abrir morte, painel, trade e voz;
2. registrar contagem de comandos, hooks, timers, sockets e listeners;
3. tocar o entrypoint dez vezes, esperando `Shutdown concluído` e
   `Core readiness approved` a cada rodada;
4. confirmar um único processamento por connect, disconnect, UI e morte;
5. confirmar que VOIP recupera a mesma porta e o MariaDB não acumula pools;
6. provocar um entrypoint inválido e confirmar falha fechada sem runtime parcial;
7. reiniciar o processo completo ao fim e comparar os mesmos contadores.

Até essa evidência existir, o status correto é **arquitetado e testado fora da
engine**, não “hot reload comprovadamente seguro”.
