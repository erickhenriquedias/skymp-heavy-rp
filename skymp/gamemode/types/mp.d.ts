/**
 * types/mp.d.ts
 *
 * Tipagem da API global `mp` que o servidor SkyMP injeta no gamemode.
 *
 * Por que isto existe: o SkyMP não publica typings. O `skymp5-functions-lib`
 * upstream tem um `src/types/mp.ts`, mas esse diretório não está no
 * repositório público — só o `index.ts`. Sem este arquivo, `mp` é `any`
 * implícito em ~30 arquivos do gamemode, então erro de nome de método ou de
 * ordem de argumento só aparece em runtime, dentro do jogo, onde é caro achar.
 *
 * PROCEDÊNCIA DE CADA ASSINATURA — importa, porque metade veio de documentação
 * oficial e metade de engenharia reversa do nosso próprio uso:
 *
 *   [DOC]  Documentado em github.com/skyrim-multiplayer/skymp, pasta docs/
 *          (docs_serverside_scripting_reference.md, docs_events_system.md,
 *          docs_clientside_scripting_reference.md).
 *   [USO]  NÃO documentado upstream. Assinatura inferida das chamadas reais
 *          neste gamemode, que funcionam contra o servidor. Trate como
 *          "observado", não como contrato garantido — pode mudar sem aviso
 *          numa atualização do SkyMP.
 *
 * Ao descobrir uma assinatura nova em teste real, adicione aqui com [USO] e
 * diga onde foi observada. Ver docs/technical/SKYMP_UPSTREAM_REFERENCE.md.
 */

/** FormID de 32 bits. Atores de jogador ficam na faixa 0xff000000+. */
type FormId = number;

/**
 * Descritor textual de um form, no formato `"<hex>:<nomeDoPlugin>"`
 * (ex: `"162e2:Skyrim.esm"`). É a forma estável de referenciar um form entre
 * servidor e cliente — o FormID numérico depende da load order.
 */
type FormDesc = string;

/** Posição/rotação e célula de um objeto. Property `locationalData`. */
interface LocationalData {
  pos: [number, number, number];
  rot: [number, number, number];
  cellOrWorldDesc: FormDesc;
}

/** Valor que atravessa a ponte Papyrus. Papyrus não tem tipos ricos. */
type PapyrusValue = string | number | boolean | null | PapyrusObject | PapyrusValue[];

/** Referência a um objeto Papyrus, obtida via `Game.getFormEx` e afins. */
interface PapyrusObject {
  type: string;
  desc: FormDesc;
}

/** [DOC] Opções de `mp.makeProperty`. */
interface MakePropertyOptions {
  /** Se false, `updateOwner` nunca roda — o próprio dono não vê o valor. */
  isVisibleByOwner: boolean;
  /** Se false, `updateNeighbor` nunca roda — vizinhos não veem o valor. */
  isVisibleByNeighbors: boolean;
  /**
   * Corpo de função JS executado NO CLIENTE do dono a cada update.
   * É uma string, não uma função: o texto é enviado e avaliado no cliente,
   * então não fecha sobre nada do escopo do servidor. Dentro dele existe
   * `ctx` (ver ClientCtx).
   */
  updateOwner: string;
  /** Igual ao anterior, mas roda no cliente de cada vizinho sincronizado. */
  updateNeighbor: string;
}

/**
 * [DOC] O objeto `ctx` disponível dentro das strings de `updateOwner`,
 * `updateNeighbor` e `makeEventSource`. Existe só no cliente.
 *
 * Declarado aqui para servir de referência ao escrever esses snippets — o
 * TypeScript não checa o conteúdo de uma string, então isto é documentação
 * navegável, não verificação.
 */
interface ClientCtx {
  /**
   * API do Skyrim Platform (`ctx.sp.Game`, `ctx.sp.on`, ...).
   *
   * Continua `any` de propósito: o conteúdo de uma string de snippet não é
   * checado pelo TypeScript, então tipar isto não verificaria nada — o valor
   * está em registrar a procedência do que se usa lá dentro.
   *
   * O que este gamemode usa hoje, e de onde veio cada coisa:
   *
   *   [DOC]  `ctx.sp.browser.setVisible / setFocused / executeJavaScript`
   *          — ponte para a CEF. Em produção desde a Fase 0
   *          (phase0-basic.js), é o caminho de `browserModal`, `panelData` e
   *          `voipTicket`.
   *   [DOC]  `ctx.sp.on(nomeDoEvento, cb)` — assinatura de evento do cliente.
   *          Lista completa em `docs/skyrim_platform/new_events.md` upstream.
   *          Usado com `'hit'` em core/hit-events.js.
   *   [DOC]  `ctx.sp.on('update', cb)` — *"Called once for every frame in the
   *          game (60 times per second at 60 FPS) after you've loaded a save
   *          or started a new game."* Mesma fonte. É o relógio da nametag.
   *   [DOC]  `ctx.sp.worldPointToScreenPoint(...pontos: number[][]): number[][]`
   *          — *"convert an array of points in the game world to an array of
   *          points on the user's screen. The dot on the screen is indicated by
   *          3 numbers from -1 to 1."*
   *          Fonte: `docs/skyrim_platform/new_methods.md` upstream; assinatura
   *          das tipagens oficiais (`skyrim-platform/skyrim-platform`,
   *          `index.d.ts`).
   *
   *          ⚠️ **Documentada, nunca chamada por este projeto.** A
   *          convenção dos eixos e o comportamento para um ponto atrás da
   *          câmera não estão na documentação e não foram observados. Ver
   *          `nametag-service.js` §4 antes de confiar nisto.
   *   [USO]  `ctx.sp.Game.getFormEx(id)` + `ctx.sp.ObjectReference.from(form)`
   *          — obter uma referência a partir de um FormID de cliente.
   *          Inferido do idioma do Skyrim Platform; **não observado aqui**.
   */
  sp: any;
  /** Em `updateOwner`, equivale a `ctx.sp.Game.getPlayer()`. Em `makeProperty`, undefined. */
  refr: any;
  /** Valor atual da property sendo processada. */
  value: any;
  /** Objeto gravável que persiste entre chamadas. Compartilhado entre properties. */
  state: Record<string, any>;
  get(propertyName: string): any;
  /** Só em `makeEventSource`: manda um evento pro servidor. */
  sendEvent(payload?: any): void;
  /** Respawna `ctx.refr` imediatamente. */
  respawn(): void;
  getFormIdInServerFormat(clientFormId: FormId): FormId;
  getFormIdInClientFormat(serverFormId: FormId): FormId;
}

/** Evento vindo da UI CEF via `mp.onUiEvent`. */
interface UiEvent {
  /** Prefixado por módulo (`governance:*`, `panel:*`) — ver core/ui-event-router.js. */
  type: string;
  data?: any;
  [key: string]: any;
}

interface Mp {
  // ───────────────────────────────────────────────────────────────────────
  // Properties e eventos — [DOC]
  // ───────────────────────────────────────────────────────────────────────

  /**
   * [DOC] Cria uma property anexada a todos os MpActor/MpObjectReference.
   * Valores são persistidos automaticamente pelo servidor.
   */
  makeProperty(propertyName: string, options: MakePropertyOptions): void;

  /**
   * [DOC] Cria uma fonte de evento cliente→servidor injetando JS no cliente.
   * O handler no servidor é `mp._nomeDoEvento = (pcFormId) => {}`.
   *
   * ATENÇÃO: nome customizado TEM que começar com underscore.
   *
   * É a alternativa nativa ao polling — ver
   * docs/technical/SKYMP_UPSTREAM_REFERENCE.md §2. Lembre que o snippet roda
   * no cliente, que não é confiável: o evento é uma dica, não uma prova.
   */
  makeEventSource(eventName: string, functionBody: string): void;

  /**
   * [DOC] Lê uma property. `undefined` se não houver valor.
   *
   * Properties usadas por este gamemode: `baseDesc`, `locationalData`, `pos`,
   * `neighbors`, `type`, mais as criadas por `makeProperty`.
   *
   * ⚠️ **`'inventory'`** é **[DOC]** (`SKYMP_UPSTREAM_REFERENCE.md` §2.5) e
   * ainda não foi exercitada numa sessão real deste projeto. O formato
   * `{ entries: [{ baseId, count, ...extraData }] }` foi confirmado no upstream
   * fixado (`InventoryBinding.cpp` -> `Inventory::ToJson`); o teste in-game
   * continua obrigatório para validar o artefato efetivamente executado.
   * As duas vezes em que este projeto assumiu formato de API sem ver — o `self`
   * do Papyrus e o require nu de `dotenv` — custaram caro e só apareceram em
   * jogo.
   */
  get(formId: FormId, propertyName: string): any;

  /**
   * [DOC] Escreve uma property.
   *
   * ⚠️ Vale para `'inventory'` o mesmo aviso de `get`, com um risco a mais: se
   * a API aceitar a chamada e **ignorar o valor em silêncio**, nenhuma exceção
   * avisa. Confirme relendo — é o que `corpse-probe.js` faz, e o motivo de ele
   * ter um passo separado só para isso.
   */
  set(formId: FormId, propertyName: string, newValue: any): void;

  /** [DOC] Limpa properties e event sources adicionados. */
  clear(): void;

  // ───────────────────────────────────────────────────────────────────────
  // Papyrus — [USO]
  // ───────────────────────────────────────────────────────────────────────

  /**
   * [USO] Chama uma função Papyrus no cliente. É a única forma de o servidor
   * fazer o jogo executar algo.
   *
   * @param callType 'global' para função estática, 'method' para método de instância
   * @param className Classe Papyrus ('Debug', 'Game', 'Actor', 'ObjectReference')
   * @param functionName Nome da função
   * @param self Objeto alvo em 'method'; `null` em 'global'. VER AVISO ABAIXO.
   * @param args Argumentos
   *
   * ⚠️ O parâmetro `self` PRECISA ser um objeto `{type, desc}`, nunca o FormID.
   *
   * Isso foi confirmado pelos nove testes oficiais do SkyMP (`misc/tests/` no
   * repositório upstream), que usam essa forma exclusivamente — inclusive para
   * argumentos que sejam referências:
   *
   *     mp.callPapyrusFunction("method", "ObjectReference", "RemoveAllItems",
   *         { type: "form", desc: mp.getDescFromId(actorId1) },
   *         [{ type: "form", desc: mp.getDescFromId(actorId2) }, false, false]);
   *
   * Use os helpers de `core/papyrus.js` (`actorRef`, `baseRef`) em vez de
   * montar o objeto à mão.
   *
   * O tipo ainda aceita `FormId` porque o SkyMP pode aceitar as duas formas —
   * o que os testes provam é que a de objeto funciona, não que a outra falha.
   * Mas todo código deste gamemode usa a de objeto, e código novo deve seguir.
   */
  callPapyrusFunction(
    callType: 'global' | 'method',
    className: string,
    functionName: string,
    self: PapyrusObject | FormId | null,
    args: PapyrusValue[]
  ): any;

  // ───────────────────────────────────────────────────────────────────────
  // Forms e atores — [USO]
  // ───────────────────────────────────────────────────────────────────────

  /** [USO] FormID → descritor textual. Use pra atravessar a ponte Papyrus. */
  getDescFromId(formId: FormId): FormDesc;

  /** [USO] Descritor textual → FormID. */
  getIdFromDesc(desc: FormDesc): FormId;

  /**
   * [USO] Atores associados a um profileId. `0` devolve os atores que o
   * servidor reconheceu sem perfil.
   *
   * Para o caminho ator -> profile, leia a property nativa
   * `mp.get(actorId, 'profileId')` em O(1).
   */
  getActorsByProfileId(profileId: number): FormId[] | undefined;

  /** [USO] Cria uma instância de um baseId no mundo. Devolve `{ desc }`. */
  place(baseId: FormId): { desc: FormDesc };

  /**
   * [USO] Lê o record de um FormID nos plugins carregados (a load order do
   * `server-settings.json`).
   *
   * **Formato confirmado num servidor real em 06/08/2026**, não inferido — uma
   * sonda temporária foi apontada como gamemode e o retorno foi lido do log.
   * A distinção importa: as duas vezes em que este projeto assumiu formato de
   * API sem ver (o `self` do Papyrus, o require nu de dotenv) custaram caro.
   *
   *     mp.lookupEspmRecordById(0x0000000f)
   *     // { record: { id: 15, editorId: 'Gold001', type: 'MISC', flags: 0,
   *     //             fields: [{ type: 'EDID', data: {...} }, ...] },
   *     //   fileIndex, toGlobalRecordId }
   *
   * **Devolve `{}` — objeto vazio, sem `record` — quando o FormID não é um
   * record de plugin.** Não lança e não devolve `null`. Confirmado com `0x14`
   * (o Player, que é referência e não record) e com um FormID inexistente.
   * Por isso a checagem correta é `r && r.record`: `{}` é truthy.
   *
   * `type` é a tag de 4 letras do record (`WEAP`, `ARMO`, `MISC`, `ALCH`...).
   * Ver `core/espm.js`, que embrulha isto com cache — o retorno traz todos os
   * fields em bytes e é imutável enquanto o servidor roda.
   */
  lookupEspmRecordById(formId: FormId): {
    record?: {
      id: number;
      editorId: string;
      type: string;
      flags: number;
      fields: { type: string; data: Record<string, number> }[];
    };
    fileIndex?: unknown;
    toGlobalRecordId?: unknown;
  };

  // ───────────────────────────────────────────────────────────────────────
  // Conexões — [USO]
  // ───────────────────────────────────────────────────────────────────────

  /** [CPP] Eventos nativos do transporte; `userId` é o slot da conexão. */
  on(event: 'connect', handler: (userId: number) => void): void;
  on(event: 'disconnect', handler: (userId: number) => void): void;

  /** [USO] Se o userId está conectado. */
  isConnected(userId: number): boolean;

  /**
   * [USO] Ator de um usuário conectado.
   *
   * ATENÇÃO: falha/retorna nada no momento em que a desconexão é detectada —
   * a engine já destruiu o ator. Por isso `connection-monitor.js` mantém o
   * `actorId` na sessão enquanto o jogador está conectado.
   */
  getUserActor(userId: number): FormId | undefined;

  /**
   * [CPP] Desconecta um usuário. O argumento é o **userId** — o slot de
   * conexão —, nunca um FormID:
   *
   *     auto userId = info[0].As<Napi::Number>().Uint32Value();
   *     server->CloseConnection(userId);      // ScampServer.cpp
   *
   * Esta assinatura já esteve documentada aqui como "aceita userId em
   * phase0-basic; actorId em admin-service", o que descrevia um bug como se
   * fosse contrato: FormID de ator do servidor vive em 0xff000000+ e fecha um
   * slot que não existe. Ver docs/research/SKYMP_INTEGRATION_AUDIT.md §6.
   *
   * Prefira `core/skymp-adapter`: `skymp.kick(actorId)` converte,
   * `skymp.kickUser(userId)` passa direto.
   */
  kick(userId: number): void;

  /** [CPP] userId dono deste ator. É o conversor que `kick` exige. */
  getUserByActor(actorId: FormId): number;

  /** [CPP] GUID da conexão. Usado upstream para detectar troca de slot em operação assíncrona. */
  getUserGuid(userId: number): string;

  /** [CPP] IP do usuário conectado. */
  getUserIp(userId: number): string;

  /** [CPP] Nome do ator. */
  getActorName(actorId: FormId): string;

  /** [CPP] Célula ou worldspace do ator, sem passar por Papyrus. */
  getActorCellOrWorld(actorId: FormId): string;

  /** [CPP] Posição do ator. */
  getActorPos(actorId: FormId): [number, number, number];

  /** [CPP] Cria um ator no mundo. `profileId` 0 para NPC sem dono. */
  createActor(
    profileId: number,
    pos: [number, number, number],
    angleZ: number,
    cellOrWorld: number,
    userProfileId?: number
  ): FormId;

  /** [CPP] Destrói um ator criado pelo servidor. */
  destroyActor(actorId: FormId): void;

  /** [CPP] Liga/desliga um ator (o mesmo que `Disable`/`Enable`, sem Papyrus). */
  setEnabled(actorId: FormId, enabled: boolean): void;

  /** [CPP] Abre o menu de raça no cliente daquele ator. */
  setRaceMenuOpen(actorId: FormId, open: boolean): void;

  /** [CPP] Associa um ator a um usuário conectado. */
  setUserActor(userId: number, actorId: FormId): void;

  /** [CPP] Envia um pacote arbitrário ao cliente. É o caminho servidor→cliente fora de properties. */
  sendCustomPacket(userId: number, jsonContent: string): void;

  // ───────────────────────────────────────────────────────────────────────
  // Mundo, plugins e diagnóstico — [CPP]
  //
  // Todas lidas de ScampServer.cpp em d85f18d8. Nenhuma é usada por este
  // gamemode hoje; estão aqui porque a auditoria de 14/08 mostrou que metade
  // do que precisávamos já existia e ninguém sabia. Ver
  // docs/research/SKYMP_INTEGRATION_AUDIT.md §2.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * [CPP] A load order que o **servidor** carregou, na ordem em que ele indexa.
   * É a fonte de verdade da paridade de plugin — ver
   * docs/technical/PLUGIN_LOAD_ORDER_STRATEGY.md.
   */
  getEspmLoadOrder(): string[];

  /** [CPP] Vizinhos por posição, calculados pelo motor. */
  getNeighborsByPosition(cellOrWorld: number, pos: [number, number, number]): FormId[];

  /** [CPP] Todos os forms conhecidos pelo servidor. */
  getAllForms(): FormId[];

  /** [CPP] Forms cuja property indexada tem este valor. Exige property criada com `isIndexed`. */
  findFormsByPropertyValue(propertyName: string, value: unknown): FormId[];

  /** [CPP] O `server-settings.json` como o servidor o entendeu. */
  getServerSettings(): Record<string, unknown>;

  /** [CPP] String localizada de um plugin. */
  getLocalizedString(stringId: number, lang?: string): string;

  /** [CPP] Métricas Prometheus do motor. */
  getPrometheusMetrics(): string;

  /**
   * [CPP] Registra uma função nativa nova no VM Papyrus, implementada em JS.
   * Ver docs/technical/PAPYRUS_USAGE_POLICY.md §5 — use prefixo de classe
   * própria, nunca sobrescreva nome vanilla.
   */
  registerPapyrusFunction(
    callType: 'method' | 'global',
    className: string,
    functionName: string,
    f: (self: unknown, args: unknown[]) => unknown
  ): void;

  /**
   * [CPP] Cliente de rede headless dentro do processo do servidor. É como o
   * upstream roda `misc/tests/`. Candidato a harness de integração —
   * `BOUND-008` na auditoria.
   */
  createBot(): { send(packet: string): void; tick(): void; destroy(): void };

  /** [CPP] Grava o tráfego de um usuário, para repro determinística. */
  setPacketHistoryRecording(userId: number, isRecording: boolean): void;
  /** [CPP] O tráfego gravado. */
  getPacketHistory(userId: number): unknown;
  /** [CPP] Descarta o tráfego gravado. */
  clearPacketHistory(userId: number): void;
  /** [CPP] Reproduz um tráfego gravado contra o servidor. */
  requestPacketHistoryPlayback(userId: number, packetHistory: unknown): void;

  // ── Reflexão do VM Papyrus ─────────────────────────────────────────────
  //
  // Respondem, em runtime, o que o VM realmente implementa. É o que torna
  // desnecessário confiar numa lista estática — ver
  // core/skymp-adapter/papyrus-catalog.js e o `PAP-001` da política.

  /** [CPP] Classes que o VM conhece. */
  _sp3ListClasses(): string[];
  /** [CPP] Classe-base de uma classe. */
  _sp3GetBaseClass(className: string): string;
  /** [CPP] Funções estáticas de uma classe. */
  _sp3ListStaticFunctions(className: string): string[];
  /** [CPP] Métodos de uma classe. */
  _sp3ListMethods(className: string): string[];
  /** [CPP] A implementação, ou nulo se a função não existe. */
  _sp3GetFunctionImplementation(className: string, functionName: string, isStatic: boolean): unknown;
  /** [CPP] Cast dinâmico entre classes do VM. */
  _sp3DynamicCast(object: unknown, className: string): unknown;

  // ───────────────────────────────────────────────────────────────────────
  // Callbacks que o gamemode ATRIBUI (não chama) — [USO]
  // ───────────────────────────────────────────────────────────────────────

  /**
   * ⚠️ **NÃO EXISTE NO SKYMP.** Busca por `onUiEvent` em `skymp5-client/src`,
   * `skymp5-server/cpp`, `skymp5-front/src` e `skymp5-functions-lib/src` no
   * commit `d85f18d8`: zero ocorrências. O servidor nunca chama esta property,
   * e `core/ui-event-gateway.js` a atribui em vão.
   *
   * O caminho real é `makeEventSource('_onUiEvent', …)` com um snippet de
   * cliente que assina `browserMessage` — ver
   * docs/research/SKYMP_INTEGRATION_AUDIT.md §5 (`BOUND-004`).
   *
   * Mantida na tipagem só enquanto o gateway ainda a referencia. Sai junto com
   * a correção.
   */
  onUiEvent: (pcFormId: FormId, uiEvent: UiEvent) => void;

  /**
   * [TESTE OFICIAL] Morte de um ator — **com o FormID de quem matou**.
   * `killerId` é `0` quando não há autor (queda, veneno, `set isDead`).
   *
   * Isto existe desde sempre e nós não usávamos: `death-service.js` faz
   * polling de 2s lendo `getActorValue('Health')`, e a documentação de combate
   * deste projeto chegou a registrar que "não há hook confiável de quem atacou
   * quem". Há — para o momento da morte, que é o que importa pro anti-RDM.
   *
   * Fonte: `misc/tests/test_isdead.js` upstream.
   */
  onDeath: (actorId: FormId, killerId: FormId) => void;

  /** [TESTE OFICIAL] Respawn de um ator. Fonte: `test_isdead.js`. */
  onRespawn: (actorId: FormId) => void;

  /**
   * [TESTE OFICIAL] Alguém ativou (usou) um objeto ou ator.
   * Fonte: `misc/tests/test_onactivate.js`.
   */
  onActivate: (targetId: FormId, casterId: FormId) => void;

  /**
   * [FONTE: skymp5-server/ts/systems/login.ts] Chamado antes de liberar o
   * login, com o `profileId` já resolvido pelo master API. Retornar `false`
   * recusa a conexão e o cliente recebe `loginFailedBanned`.
   *
   * É o ponto correto pra checagem de whitelist e ban — hoje `whitelist.js`
   * roda após o evento de conexão e usa `mp.kick` depois do fato.
   */
  onLoginAttempt: (profileId: number) => boolean;

  /**
   * Handlers de `makeEventSource`. Nomes customizados começam com underscore,
   * então não dá pra declará-los um a um — este index signature os cobre.
   */
  [customEventHandler: string]: any;
}

/**
 * A global que o servidor SkyMP injeta.
 *
 * Fora do servidor (testes com `node --test`) ela NÃO existe — por isso todo
 * serviço deste gamemode começa com `if (typeof mp === 'undefined') return;`.
 * O tipo é não-opcional aqui porque `typeof mp === 'undefined'` já é o guard
 * idiomático do projeto e declarar `mp` como possivelmente undefined obrigaria
 * a checagem redundante em todo lugar.
 */
declare const mp: Mp;
