import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthData, LaunchRepairAction, PublicServerStatus } from '../types/electron';
import { Play, Settings as SettingsIcon, LogOut, Wrench, XCircle } from 'lucide-react';

interface HomeProps {
  auth: AuthData;
  setAuth: (auth: AuthData | null) => void;
}

const QUEUE_POLL_INTERVAL_MS = 4000;
const SERVER_STATUS_INTERVAL_MS = 15000;
const INITIAL_SERVER_STATUS: PublicServerStatus = {
  state: 'starting',
  players: 0,
  capacity: 0,
  queue: 0,
  message: 'Consultando o servidor...',
};

const SERVER_STATUS_VIEW = {
  online: { label: 'Online', color: 'var(--success)' },
  full: { label: 'Lotado', color: 'var(--accent-gold)' },
  starting: { label: 'Inicializando', color: 'var(--accent-gold)' },
  maintenance: { label: 'Manutenção', color: 'var(--accent-gold)' },
  offline: { label: 'Offline', color: 'var(--error)' },
} as const;

export function Home({ auth, setAuth }: HomeProps) {
  const navigate = useNavigate();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isUpdateActive, setIsUpdateActive] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [repairAction, setRepairAction] = useState<LaunchRepairAction | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [serverStatus, setServerStatus] = useState<PublicServerStatus>(INITIAL_SERVER_STATUS);
  const queuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopQueuePolling = () => {
    if (queuePollRef.current !== null) {
      clearInterval(queuePollRef.current);
      queuePollRef.current = null;
    }
  };

  useEffect(() => {
    let active = true;
    let refreshPending = false;
    const refreshServerStatus = async () => {
      if (refreshPending) return;
      refreshPending = true;
      try {
        const next = await window.electronAPI.getServerStatus();
        if (active) setServerStatus(next);
      } catch {
        if (active) setServerStatus({
          state: 'offline', players: 0, capacity: 0, queue: 0,
          message: 'Não foi possível consultar o servidor.',
        });
      } finally {
        refreshPending = false;
      }
    };
    void refreshServerStatus();
    const statusTimer = setInterval(refreshServerStatus, SERVER_STATUS_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(statusTimer);
      stopQueuePolling();
    };
  }, []);

  useEffect(() => {
    const showProgress = (scope: string) => (value: { phase?: string; percent?: number }) => {
      const percent = Number.isFinite(value?.percent) ? ` ${value.percent}%` : '';
      setStatus(`${scope}: ${value?.phase || 'processando'}${percent}`);
    };
    window.electronAPI.onUpdateProgress(showProgress('Atualizando cliente'));
    window.electronAPI.onModsUpdateProgress(showProgress('Atualizando mods'));
  }, []);

  const launchPreparedGame = async (gamePath: string, ticket: string, preparationToken: string) => {
    setStatus('Iniciando Skyrim...');
    setIsPlaying(true);
    const launched = await window.electronAPI.launchGame(gamePath, ticket, preparationToken);
    setIsPlaying(false);
    if (!launched.success) {
      setRepairAction('retry');
      setStatus(`Não foi possível iniciar: ${launched.error || 'preparação recusada'}`);
    }
  };

  const startQueuePolling = (gamePath: string, preparationToken: string) => {
    stopQueuePolling();
    queuePollRef.current = setInterval(async () => {
      try {
        const pollRes = await window.electronAPI.pollQueue(preparationToken, gamePath);
        if (pollRes.status === 'queued') {
          setStatus(`Na fila (posicao: ${pollRes.position})`);
          return;
        }
        stopQueuePolling();
        if (pollRes.status === 'success') {
          await launchPreparedGame(gamePath, pollRes.ticket, preparationToken);
          return;
        }
        if (pollRes.message === 'preparation_required') {
          setRepairAction('retry');
          setStatus('A verificação expirou durante a fila. Valide novamente para continuar.');
        } else {
          setStatus(`Erro: ${pollRes.message || 'fila indisponivel'}`);
        }
      } catch (e: any) {
        stopQueuePolling();
        setStatus(`Erro: ${e.message}`);
      }
    }, QUEUE_POLL_INTERVAL_MS);
  };

  const handleLogout = async () => {
    stopQueuePolling();
    await window.electronAPI.discordLogout();
    setAuth(null);
  };

  const handlePlay = async () => {
    if (serverStatus.state === 'maintenance' || serverStatus.state === 'starting' || serverStatus.state === 'offline') {
      setStatus(serverStatus.message || 'Servidor indisponível no momento.');
      return;
    }
    setIsPlaying(true);
    setRepairAction(null);
    setProblems([]);
    setStatus('Verificando pasta do jogo...');
    try {
      const config = await window.electronAPI.getLauncherConfig();
      const gamePath = config.gamePath;
      if (!gamePath) {
        setStatus('Configure a pasta do Skyrim antes de jogar.');
        navigate('/settings');
        return;
      }

      const pathOk = await window.electronAPI.checkGamePath(gamePath);
      if (!pathOk.ok) {
        setStatus(`Pasta do jogo invalida: ${pathOk.reason}`);
        navigate('/settings');
        return;
      }

      await window.electronAPI.ensureSkyrimIni({ repairOnly: true });

      setStatus('Conferindo atualizações, modpack e load order...');
      const preparation = await window.electronAPI.prepareToPlay(gamePath);
      if (preparation.status !== 'ready' || !preparation.preparationToken) {
        const nextProblems = Array.isArray(preparation.problems) ? preparation.problems : [];
        setProblems(nextProblems);
        setRepairAction(preparation.action || 'retry');
        const visible = nextProblems.slice(0, 3).join(' · ');
        const remaining = Math.max(0, nextProblems.length - 3);
        setStatus(`${preparation.message || 'Preparação para jogar falhou.'}${visible ? ` ${visible}${remaining > 0 ? ` · e mais ${remaining}` : ''}` : ''}`);
        return;
      }

      setStatus('Entrando na fila...');
      const queueRes = await window.electronAPI.joinQueue(preparation.preparationToken, gamePath);
      if (queueRes.status === 'queued') {
        setStatus(`Na fila (posicao: ${queueRes.position})`);
        startQueuePolling(gamePath, preparation.preparationToken);
        return;
      }
      if (queueRes.status === 'success') {
        await launchPreparedGame(gamePath, queueRes.ticket, preparation.preparationToken);
        return;
      }
      if (queueRes.message === 'preparation_required') {
        setRepairAction('retry');
        setStatus('A preparação expirou. Valide novamente antes de entrar na fila.');
      } else {
        setStatus(`Erro: ${queueRes.message || 'fila indisponivel'}`);
      }
    } catch (e: any) {
      setStatus(`Erro: ${e.message}`);
    } finally {
      setIsPlaying(false);
    }
  };

  const handleRepair = async () => {
    if (!repairAction) return;
    if (repairAction === 'settings') {
      navigate('/settings');
      return;
    }
    if (repairAction === 'retry') {
      await handlePlay();
      return;
    }
    const config = await window.electronAPI.getLauncherConfig();
    if (!config.gamePath) {
      navigate('/settings');
      return;
    }
    const labels: Record<string, string> = {
      'update-client': 'Atualizar cliente',
      'update-mods': 'Atualizar modpack',
      'repair-mods': 'Reparar arquivos divergentes',
    };
    if (!confirm(`${labels[repairAction]} agora? O jogo precisa permanecer fechado.`)) return;
    setIsPlaying(true);
    setIsUpdateActive(true);
    setProblems([]);
    setStatus(`${labels[repairAction]}...`);
    try {
      let result = repairAction === 'update-client'
        ? await window.electronAPI.installClientUpdate(config.gamePath)
        : repairAction === 'update-mods'
          ? await window.electronAPI.installModsUpdate(config.gamePath, false)
          : await window.electronAPI.repairModsIncremental(config.gamePath, false);
      if (result.confirmationRequired) {
        const sizeMb = Math.ceil(Number(result.downloadBytes || 0) / (1024 * 1024));
        if (!confirm(`O repair precisa baixar aproximadamente ${sizeMb} MB. Continuar?`)) {
          setStatus('Repair cancelado antes do download.');
          return;
        }
        result = await window.electronAPI.repairModsIncremental(config.gamePath, true);
      }
      if (!result.success) {
        if (result.cancelled) {
          setStatus('Operação cancelada com segurança. Nenhum arquivo foi publicado.');
          return;
        }
        const manual = Array.isArray(result.manualFiles) ? ` Arquivos manuais: ${result.manualFiles.slice(0, 5).join(', ')}` : '';
        const unsafe = Array.isArray(result.unsafeFiles) ? ` Destinos inseguros: ${result.unsafeFiles.slice(0, 5).join(', ')}` : '';
        setStatus(`Falha no reparo: ${result.error || 'erro desconhecido'}${manual}${unsafe}`);
        return;
      }
      setRepairAction(null);
      setStatus('Reparo concluído. Validando novamente...');
      await handlePlay();
    } catch (e: any) {
      setStatus(`Falha no reparo: ${e.message}`);
    } finally {
      setIsUpdateActive(false);
      setIsPlaying(false);
    }
  };

  const handleCancelUpdate = async () => {
    const result = await window.electronAPI.cancelUpdateOperation();
    if (result.success) {
      setStatus(result.alreadyRequested ? 'Cancelamento já solicitado...' : 'Cancelando com segurança...');
      return;
    }
    if (result.reason === 'commit_in_progress') {
      setStatus('A publicação final já começou e não pode ser interrompida. Aguarde a conclusão.');
      return;
    }
    setStatus('Não há download ou reparo cancelável em andamento.');
  };

  const serverView = SERVER_STATUS_VIEW[serverStatus.state];
  const cannotJoin = ['maintenance', 'starting', 'offline'].includes(serverStatus.state);
  const population = serverStatus.capacity > 0
    ? `${serverStatus.players}/${serverStatus.capacity} jogadores${serverStatus.queue > 0 ? ` · ${serverStatus.queue} na fila` : ''}`
    : serverStatus.message;

  return (
    <div className="page-container" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {auth.avatar ? (
            <img src={auth.avatar} alt="Avatar" style={{ width: '48px', height: '48px', borderRadius: '50%', border: '2px solid var(--border-color)' }} />
          ) : (
            <div style={{ width: '48px', height: '48px', borderRadius: '50%', backgroundColor: 'var(--border-color)' }} />
          )}
          <div>
            <div style={{ fontWeight: 600, fontSize: '18px' }}>{auth.globalName}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Logado via Discord</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="btn-secondary" onClick={() => navigate('/settings')} title="Configuracoes">
            <SettingsIcon size={20} />
          </button>
          <button className="btn-secondary" onClick={handleLogout} title="Sair">
            <LogOut size={20} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px' }}>
        <h1 style={{ fontSize: '48px', color: 'var(--accent-gold)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Skyrim Heavy RP</h1>

        <div style={{
          background: 'var(--bg-panel)',
          padding: '24px',
          borderRadius: '8px',
          border: '1px solid var(--border-color)',
          width: '100%',
          maxWidth: '400px',
          textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '16px', color: 'var(--text-muted)', marginBottom: '16px', textTransform: 'uppercase' }}>Status do Servidor</h2>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '8px' }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: serverView.color }} />
            <span style={{ fontSize: '20px', fontWeight: 600 }}>{serverView.label}</span>
          </div>
          <p style={{ color: 'var(--text-muted)' }}>{population}</p>
        </div>

        <button
          className="btn-primary"
          style={{ width: '100%', maxWidth: '400px', padding: '20px', fontSize: '24px' }}
          onClick={handlePlay}
          disabled={isPlaying || cannotJoin}
        >
          <Play size={28} />
          {isPlaying ? 'AGUARDE' : serverStatus.state === 'full' ? 'ENTRAR NA FILA' : 'JOGAR'}
        </button>

        {isUpdateActive && (
          <button className="btn-secondary" onClick={handleCancelUpdate} style={{ padding: '10px 18px' }}>
            <XCircle size={18} />
            CANCELAR OPERAÇÃO
          </button>
        )}

        {status && <p style={{ color: 'var(--accent-gold)', textAlign: 'center', maxWidth: '620px' }}>{status}</p>}
        {repairAction && (
          <button className="btn-secondary" onClick={handleRepair} disabled={isPlaying} style={{ padding: '12px 20px' }}>
            <Wrench size={18} />
            {repairAction === 'update-client' ? 'ATUALIZAR CLIENTE'
              : repairAction === 'update-mods' ? 'ATUALIZAR MODS'
                : repairAction === 'repair-mods' ? 'REPARAR MODS'
                  : repairAction === 'settings' ? 'ABRIR CONFIGURAÇÕES' : 'TENTAR NOVAMENTE'}
          </button>
        )}
        {problems.length > 0 && (
          <details style={{ color: 'var(--text-muted)', maxWidth: '620px', width: '100%' }}>
            <summary>Ver diagnóstico ({problems.length})</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>{problems.join('\n')}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
