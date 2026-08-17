param(
  [ValidateSet("local", "staging", "production")]
  [string]$Environment = "local",
  [switch]$CheckOnly,
  [switch]$NoSkyMP,
  [ValidateRange(5, 600)]
  [int]$StartupTimeoutSeconds = 60
)

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

# O manifesto agora e gate do proprio boot: gamemode compara a assinatura e a
# load order efetiva antes de abrir banco/runtime.
$manifestPath = Join-Path $rootDir "apps\game-api\mods.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  $problems += "API do Jogo: apps\game-api\mods.json ausente; readiness nunca aprovaria. Gere o manifesto antes do boot."
}

if (-not $NoSkyMP) {
  $serverEntry = Join-Path $rootDir "skymp\server\dist_back\skymp5-server.js"
  $serverSettings = Join-Path $rootDir "skymp\server\server-settings.json"
  if (-not (Test-Path -LiteralPath $serverEntry)) {
    $problems += "Servidor SkyMP: artefato ausente. Execute scripts\phase0\Install-SkyMPServerArtifact.ps1."
  }
  if (-not (Test-Path -LiteralPath $serverSettings)) {
    $problems += "Servidor SkyMP: server-settings.json ausente no artefato instalado."
  } else {
    $doctor = Join-Path $rootDir "skymp\gamemode\scripts\check-server-config.js"
    $doctorOutput = & node $doctor $serverSettings "--environment=$Environment" 2>&1
    if ($LASTEXITCODE -ne 0) {
      $problems += "Servidor SkyMP: config doctor reprovou server-settings.json para $Environment."
      foreach ($line in $doctorOutput) { Write-Host "  $line" -ForegroundColor Red }
    }
  }
}

# O boot agora aplica migrations antes dos modulos e falha fechado. Este check
# continua util como diagnostico antecipado, antes de abrir as janelas.
$gamemodeDir = Join-Path $rootDir "skymp\gamemode"
$gamemodeEnv = Join-Path $gamemodeDir ".env"
if (-not (Test-Path -LiteralPath $gamemodeEnv)) {
  $problems += "Gamemode: falta skymp\gamemode\.env; o gate de load order nao possui chaves publicas."
} else {
  $gamemodeEnvText = Get-Content -LiteralPath $gamemodeEnv -Raw
  if ($gamemodeEnvText -notmatch '(?m)^\s*MODS_MANIFEST_PUBLIC_KEYS\s*=\s*\{.+\}\s*$' -or
      $gamemodeEnvText -match 'COLE_A_CHAVE_PUBLICA') {
    $problems += "Gamemode: MODS_MANIFEST_PUBLIC_KEYS ausente ou placeholder; copie o mesmo JSON publico da game-api."
  }
}
if (Test-Path -LiteralPath (Join-Path $gamemodeDir "node_modules")) {
  Push-Location $gamemodeDir
  try {
    $driftOutput = & node "scripts\check-schema-drift.js" 2>&1
    if ($LASTEXITCODE -ne 0) {
      $problems += "MariaDB indisponivel ou schema desalinhado; nenhum servico sera iniciado."
      Write-Warning "Banco indisponivel ou desalinhado das migrations:"
      foreach ($linha in $driftOutput) { Write-Host "  $linha" -ForegroundColor Yellow }
      Write-Host ""
    }
  } catch {
    Write-Warning "Nao foi possivel checar o schema: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
} else {
  $problems += "Gamemode: dependencias ausentes. Rode: cd skymp\gamemode; npm ci"
}

if ($problems.Count -gt 0) {
  Write-Host "Preflight REPROVADO; nenhum processo sera iniciado:" -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
  Write-Host ""
  exit 1
}

# ── Supervisor ───────────────────────────────────────────────────────────────
# O processo fica em foreground de proposito: esta janela e o owner do grupo.
# Fechar com Ctrl+C dispara shutdown dos filhos e impede processos orfaos.
$supervisor = Join-Path $rootDir "scripts\phase0\supervisor-cli.js"
$arguments = @(
  $supervisor,
  "--root=$rootDir",
  "--environment=$Environment",
  "--startup-timeout-ms=$($StartupTimeoutSeconds * 1000)"
)
if ($CheckOnly) { $arguments += "--check" }
if ($NoSkyMP) { $arguments += "--no-skymp" }

Write-Host "Preflight aprovado. Entregando processos ao supervisor..." -ForegroundColor Green
& node @arguments
exit $LASTEXITCODE
