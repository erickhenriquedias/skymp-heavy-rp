# Supervisor oficial dos serviços

O entrypoint operacional é:

```powershell
.\scripts\phase0\Start-AllServices.ps1 -Environment local
```

Ele não abre mais janelas independentes e encerra. A janela atual permanece
como owner de `painel-web`, `discord-bot`, `game-api` e `skymp-server`.

## Preflight fail-closed

Nenhum filho é criado enquanto todos estes gates não terminarem:

- entrypoint, `.env` e `node_modules` existem;
- variáveis obrigatórias não estão vazias ou com placeholder;
- manifesto de mods existe;
- config doctor aprova `server-settings.json` para o ambiente informado;
- MariaDB responde e o schema confere com as migrations;
- portas TCP/UDP estão livres, inclusive a UI SkyMP em `port + 1`;
- não há colisão declarada entre portas dos serviços.

`-CheckOnly` executa os gates e não abre portas. `-NoSkyMP` existe para
diagnóstico isolado dos serviços web; não representa uma topologia de produção.

## Runtime

Cada processo possui uma única instância gerenciada. Encerramento inesperado
usa backoff exponencial com jitter, de 1 até 30 segundos. A sexta queda dentro
de 60 segundos abre o circuito: o supervisor encerra o restante com código 1,
em vez de reiniciar para sempre.

Três falhas consecutivas de liveness reiniciam o serviço. Readiness reprovada
não causa restart automático: banco ou Discord indisponível não deve produzir
uma tempestade de processos. O estado fica explícito no log e pode se recuperar
sem restart quando a dependência volta.

| Serviço | Liveness | Readiness |
|---|---|---|
| painel | `GET /health` | `GET /ready`, incluindo `SELECT 1` no MariaDB |
| bot | `GET /health` | `GET /ready`, exigindo `client.isReady()` do Discord |
| game-api | `GET /health` | `GET /ready`, MariaDB + manifesto + manutenção |
| SkyMP | processo gerenciado | janela mínima + porta TCP da UI (`port + 1`) |

## Shutdown

`Ctrl+C` inicia drain dos servidores HTTP, fecha pools e destrói o client do
Discord. O supervisor espera dez segundos e só então força um filho preso.
No Windows, o próprio console entrega `Ctrl+C` ao grupo; o supervisor não envia
um `SIGTERM` adicional que cortaria o cleanup recém-iniciado.

O comportamento isolado está coberto por testes. Ainda é obrigatório executar
o protocolo real do README central: processos verdadeiros, MariaDB, Discord,
SkyMP, portas e inspeção de processos órfãos.
