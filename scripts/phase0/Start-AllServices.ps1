# Start-AllServices.ps1
# Script de orquestração para inicializar todos os serviços do servidor simultaneamente.
#
# Antes, este script só checava se o `.env` existia e despachava `node` numa
# janela nova. Se faltasse `node_modules`, o serviço morria no primeiro
# `require()` numa janela que ninguém estava olhando — e a orquestração
# imprimia "concluída" com o painel morto. Agora cada serviço é conferido de
# verdade antes de subir, e o que falta é dito em voz alta.

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# Cada serviço: pasta, arquivo de entrada, e se exige .env pra funcionar.
$services = @(
  @{ Name = "Painel Web";      Path = "apps\web";          Entry = "server.js"; RequiresEnv = $true  },
  @{ Name = "Bot do Discord";  Path = "apps\bot-discord";  Entry = "index.js";  RequiresEnv = $true  },
  @{ Name = "API do Jogo";     Path = "apps\game-api";     Entry = "server.js"; RequiresEnv = $true  }
)

Write-Host "Iniciando todos os servicos do SkyMP Heavy RP..." -ForegroundColor Cyan
Write-Host ""

# ── Pré-checagem ─────────────────────────────────────────────────────────────
# Roda inteira antes de subir qualquer coisa: é melhor listar tudo que falta de
# uma vez do que descobrir um problema por vez, a cada execução.
$problems = @()
$ready = @()

foreach ($svc in $services) {
  $dir = Join-Path $rootDir $svc.Path
  $envFile = Join-Path $dir ".env"
  $nodeModules = Join-Path $dir "node_modules"
  $entry = Join-Path $dir $svc.Entry

  if (-not (Test-Path -LiteralPath $entry)) {
    $problems += "$($svc.Name): arquivo de entrada nao encontrado ($($svc.Path)\$($svc.Entry))."
    continue
  }

  if ($svc.RequiresEnv -and -not (Test-Path -LiteralPath $envFile)) {
    $problems += "$($svc.Name): falta o .env. Copie de $($svc.Path)\.env.example e preencha."
    continue
  }

  if (-not (Test-Path -LiteralPath $nodeModules)) {
    $problems += "$($svc.Name): dependencias nao instaladas. Rode: cd $($svc.Path); npm ci"
    continue
  }

  $ready += $svc
}

# O manifesto de mods nao impede o boot, mas sem ele nenhum jogador passa da
# verificacao de paridade — entao avisamos alto em vez de deixar descobrir em jogo.
$manifestPath = Join-Path $rootDir "apps\game-api\mods.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Write-Warning "apps\game-api\mods.json nao existe: /mods.json vai responder 503 e nenhum jogador consegue entrar."
  Write-Warning "Gere com: cd apps\game-api; node scripts\generate-mods-manifest.js `"<pasta Data do servidor>`" --plugins-txt `"<plugins.txt>`""
  Write-Host ""
}

# O boot agora aplica migrations antes dos modulos e falha fechado. Este check
# continua util como diagnostico antecipado, antes de abrir as janelas.
$gamemodeDir = Join-Path $rootDir "skymp\gamemode"
if (Test-Path -LiteralPath (Join-Path $gamemodeDir "node_modules")) {
  Push-Location $gamemodeDir
  try {
    $driftOutput = & node "scripts\check-schema-drift.js" 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Banco desalinhado das migrations. Os servicos sobem, mas vao falhar em runtime:"
      foreach ($linha in $driftOutput) { Write-Host "  $linha" -ForegroundColor Yellow }
      Write-Host ""
    }
  } catch {
    Write-Warning "Nao foi possivel checar o schema: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

if ($problems.Count -gt 0) {
  Write-Host "Servicos que NAO vao subir:" -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
  Write-Host ""
}

if ($ready.Count -eq 0) {
  Write-Host "Nenhum servico esta pronto pra subir. Resolva os itens acima e rode de novo." -ForegroundColor Red
  exit 1
}

# ── Boot ─────────────────────────────────────────────────────────────────────
$i = 0
foreach ($svc in $ready) {
  $i++
  Write-Host "[$i/$($ready.Count + 1)] Iniciando $($svc.Name)..." -ForegroundColor Yellow
  Start-Process "node" -ArgumentList $svc.Entry -WorkingDirectory (Join-Path $rootDir $svc.Path) -WindowStyle Normal
}

Write-Host "[$($ready.Count + 1)/$($ready.Count + 1)] Iniciando Servidor SkyMP..." -ForegroundColor Yellow
Start-Process "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -File `"$rootDir\scripts\phase0\Start-Phase0Server.ps1`"" -WorkingDirectory "$rootDir" -WindowStyle Normal

Write-Host ""
if ($problems.Count -gt 0) {
  Write-Host "Orquestracao concluida PARCIALMENTE: $($ready.Count) de $($services.Count) servicos subiram." -ForegroundColor Yellow
} else {
  Write-Host "Orquestracao concluida: todos os servicos subiram." -ForegroundColor Green
}
Write-Host "Para jogar, abra o Launcher na pasta apps\launcher." -ForegroundColor Green
