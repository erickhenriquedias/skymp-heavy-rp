/**
 * Coordena as instancias do entrypoint que o hot reload do SkyMP cria.
 *
 * O loader upstream copia somente o entrypoint para um arquivo temporario e o
 * requer novamente. Os modulos absolutos continuam no cache CommonJS, logo
 * este modulo e deliberadamente um singleton: ele sobrevive ao reload e fecha
 * a instancia anterior antes de permitir o boot da proxima.
 */

function createRuntimeLifecycle({ processApi = process, logger = console } = {}) {
  let current = null;
  let transition = Promise.resolve();
  let terminating = false;
  let signalsInstalled = false;

  async function stopCurrent(reason) {
    const instance = current;
    if (!instance) return false;
    // Retira antes de aguardar: duas chamadas concorrentes nunca desligam a
    // mesma instancia duas vezes.
    current = null;
    await instance.shutdown(reason);
    return true;
  }

  function enqueue(operation) {
    const result = transition.then(operation);
    // Uma falha pertence ao chamador atual, mas nao pode envenenar para sempre
    // a fila: um shutdown posterior ainda precisa conseguir limpar o processo.
    transition = result.catch(() => {});
    return result;
  }

  function replace(start) {
    if (typeof start !== 'function') {
      return Promise.reject(new Error('[runtime-lifecycle] start precisa ser funcao'));
    }

    return enqueue(async () => {
      await stopCurrent('hot reload');
      const next = await start();
      if (!next || typeof next.shutdown !== 'function') {
        throw new Error('[runtime-lifecycle] instancia sem shutdown');
      }
      current = next;
      return next;
    });
  }

  function shutdown(reason = 'shutdown') {
    return enqueue(() => stopCurrent(reason));
  }

  function installSignalHandlers() {
    if (signalsInstalled) return false;
    signalsInstalled = true;

    for (const signal of ['SIGINT', 'SIGTERM']) {
      processApi.once(signal, () => {
        if (terminating) return;
        terminating = true;
        shutdown(signal)
          .then(() => processApi.exit(0))
          .catch(err => {
            logger.error('[runtime-lifecycle] Falha durante shutdown:', err.message);
            processApi.exit(1);
          });
      });
    }
    return true;
  }

  function snapshot() {
    return {
      hasCurrent: Boolean(current),
      terminating,
      signalsInstalled
    };
  }

  return { replace, shutdown, installSignalHandlers, snapshot };
}

const runtimeLifecycle = createRuntimeLifecycle();
runtimeLifecycle.installSignalHandlers();

module.exports = runtimeLifecycle;
module.exports.createRuntimeLifecycle = createRuntimeLifecycle;
