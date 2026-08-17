require('dotenv').config();
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const app = express();
const voiceChannels = require('./voiceChannels');
const moderationLog = require('./moderationLog');
const gameAccess = require('./gameAccess');
const { deployCommands } = require('./deploy-commands');
const { getBotReadiness } = require('./bot-readiness');
const { createSlidingWindowRateLimiter } = require('../../skymp/packages/sliding-rate-limiter');

app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates]
});

const GUILD_ID = process.env.GUILD_ID;
const WHITELIST_ROLE_ID = process.env.WHITELIST_ROLE_ID;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const VOICE_CATEGORY_ID = process.env.VOICE_CATEGORY_ID;
const PANEL_INTERNAL_URL = process.env.PANEL_INTERNAL_URL || 'http://127.0.0.1:3001';
const GAME_ACCESS_ROLE_IDS = gameAccess.parseGameAccessRoleIds(
    WHITELIST_ROLE_ID,
    process.env.GAME_ACCESS_ROLE_IDS
);
// Canal de log de moderação. Sem ele o endpoint continua respondendo 202 e não
// envia nada: quem configura o servidor decide se quer o canal, e um servidor
// sem canal não pode ver `/permakill` falhar por causa disso.
const MODERATION_LOG_CHANNEL_ID = process.env.MODERATION_LOG_CHANNEL_ID;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} must be set`);
    }
    return value;
}

requireEnv('DISCORD_BOT_TOKEN');
requireEnv('GUILD_ID');
requireEnv('WHITELIST_ROLE_ID');
requireEnv('INTERNAL_API_SECRET');

client.once('ready', async () => {
    console.log(`[discord-bot] Bot logado como ${client.user.tag}`);

    // Registra os slash commands no boot. Antes isso era um passo manual
    // (`npm run deploy-commands`) e nada avisava quando alguém esquecia — o
    // comando simplesmente não aparecia no Discord, sem erro nenhum.
    //
    // Uma falha aqui NÃO derruba o bot: o sync de whitelist é a função crítica
    // e continua funcionando sem os comandos de voz.
    const result = await deployCommands();
    if (result.ok) {
        console.log(`[discord-bot] ${result.count} slash command(s) registrado(s) na guild.`);
    } else {
        console.error(`[discord-bot] NAO foi possivel registrar os slash commands: ${result.error}`);
        console.error('[discord-bot] /voz-criar e /voz-fechar nao vao aparecer no Discord ate isso ser resolvido.');
    }
});

// Canais de voz temporários (/voz-criar, /voz-fechar) — ver voiceChannels.js.
// Comandos precisam ser registrados separadamente com `node deploy-commands.js`.
client.on('interactionCreate', async (interaction) => {
    try {
        await voiceChannels.handleInteraction(interaction, {
            staffRoleId: STAFF_ROLE_ID,
            voiceCategoryId: VOICE_CATEGORY_ID
        });
    } catch (err) {
        console.error('[discord-bot] Erro ao processar interação:', err.message);
    }
});

client.on('voiceStateUpdate', (oldState, newState) => {
    voiceChannels.handleVoiceStateUpdate(oldState, newState);
});

async function notifyGameAccess(member) {
    const access = gameAccess.getMemberGameAccess(member, GAME_ACCESS_ROLE_IDS);
    const response = await fetch(`${PANEL_INTERNAL_URL}/internal/discord-role-access`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': INTERNAL_API_SECRET
        },
        body: JSON.stringify({
            discord_id: member.id,
            eligible: access.eligible,
            matched_role_id: access.matchedRoleId
        })
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(`painel respondeu HTTP ${response.status}`);
    }
}

client.on('guildMemberUpdate', (oldMember, newMember) => {
    if (newMember.guild.id !== GUILD_ID) return;
    const before = gameAccess.getMemberGameAccess(oldMember, GAME_ACCESS_ROLE_IDS);
    const after = gameAccess.getMemberGameAccess(newMember, GAME_ACCESS_ROLE_IDS);
    if (before.eligible === after.eligible && before.matchedRoleId === after.matchedRoleId) return;
    notifyGameAccess(newMember).catch((err) => {
        console.error(`[discord-bot] Falha ao sincronizar acesso de ${newMember.id}: ${err.message}`);
    });
});

// ── Rate limiting simples (janela deslizante em memória) ────────────────────
const rateLimiter = createSlidingWindowRateLimiter();
function isRateLimited(key, maxRequests, windowMs) {
    return rateLimiter.isLimited(key, maxRequests, windowMs);
}

// Comparação em tempo constante para evitar timing attacks no secret interno
function isValidInternalSecret(provided) {
    if (typeof provided !== 'string' || !provided) return false;
    const expected = Buffer.from(INTERNAL_API_SECRET);
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
}

// Endpoint para receber webhook do Painel Web
app.post('/api/sync-role', async (req, res) => {
    const { discord_id, status } = req.body;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (isRateLimited(`sync-role:${ip}`, 20, 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests' });
    }

    if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
        console.warn(`[discord-bot] Tentativa de acesso não autorizada a /api/sync-role de ${ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!discord_id) return res.status(400).json({ error: 'Missing discord_id' });
    if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (!GUILD_ID || !WHITELIST_ROLE_ID) return res.status(500).json({ error: 'GUILD_ID or WHITELIST_ROLE_ID not configured' });

    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discord_id).catch(() => null);

        if (!member) {
            console.log(`[discord-bot] Membro ${discord_id} não encontrado na guild.`);
            return res.status(404).json({ error: 'Member not found in guild' });
        }

        if (status === 'approved') {
            await member.roles.add(WHITELIST_ROLE_ID);
            console.log(`[discord-bot] Cargo adicionado para ${discord_id}`);
        } else if (status === 'rejected' || status === 'pending') {
            await member.roles.remove(WHITELIST_ROLE_ID);
            console.log(`[discord-bot] Cargo removido para ${discord_id}`);
        }

        res.json({ ok: true });
    } catch (err) {
        console.error(`[discord-bot] Erro ao sincronizar:`, err);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Consulta interna usada no login do launcher. O cliente nunca informa roles:
// quem consulta a guild e decide é o bot autenticado do servidor.
app.post('/api/check-game-access', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(`check-game-access:${ip}`, 60, 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const discordId = String((req.body || {}).discord_id || '');
    if (!/^\d{5,32}$/.test(discordId)) {
        return res.status(400).json({ error: 'Invalid discord_id' });
    }

    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) return res.json({ eligible: false, matched_role_id: null });
        const access = gameAccess.getMemberGameAccess(member, GAME_ACCESS_ROLE_IDS);
        res.json({ eligible: access.eligible, matched_role_id: access.matchedRoleId });
    } catch (err) {
        console.error('[discord-bot] Erro ao consultar cargo de acesso:', err);
        res.status(503).json({ error: 'Discord unavailable' });
    }
});

/**
 * Log de moderação — ver `moderationLog.js` e `docs/ARCHITECTURE.md` 1.3.
 *
 * Responde **202 e não espera o Discord**. A ação de moderação já aconteceu
 * quando esta requisição chega: o gamemode já expulsou, o painel já gravou a
 * decisão de whitelist. Segurar a resposta até o Discord confirmar faria um
 * `/permakill` esperar por uma API de terceiro, e faria a lentidão do Discord
 * virar lentidão do comando de staff.
 *
 * Corpo inválido responde 400 — quem manda tem um bug e precisa saber.
 */
app.post('/api/moderation-log', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (isRateLimited(`moderation-log:${ip}`, 60, 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests' });
    }

    if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
        console.warn(`[discord-bot] Tentativa nao autorizada em /api/moderation-log de ${ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = moderationLog.parseEvent(req.body);
    if (!parsed.ok) {
        console.warn(`[discord-bot] Evento de moderacao recusado: ${parsed.erro}`);
        return res.status(400).json({ error: parsed.erro });
    }

    res.status(202).json({ ok: true });

    // Depois da resposta, de propósito. Uma falha aqui vira linha de log e nada
    // mais — o registro de verdade é `audit_logs`, que já foi escrito.
    moderationLog.sendModerationLog(client, parsed.evento, MODERATION_LOG_CHANNEL_ID)
        .then(r => {
            if (!r.sent && r.erro !== 'canal nao configurado') {
                console.error(`[discord-bot] Evento '${parsed.evento.kind}' nao chegou no canal: ${r.erro}`);
            }
        });
});

const PORT = process.env.PORT || 3002;
const HOST = '127.0.0.1'; // API interna: nunca expor em todas as interfaces
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/ready', (_req, res) => {
    const status = getBotReadiness(client);
    res.status(status.ready ? 200 : 503).json(status);
});

const server = app.listen(PORT, HOST, () => {
    console.log(`[discord-bot] API interna rodando em http://${HOST}:${PORT}`);
});

let shutdownPromise = null;
function shutdown(signal, exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    process.exitCode = exitCode;
    shutdownPromise = new Promise(resolve => server.close(resolve))
        .then(() => client.destroy())
        .then(() => console.log(`[discord-bot] Encerrado por ${signal}.`))
        .catch(error => {
            process.exitCode = 1;
            console.error(`[discord-bot] Falha no shutdown: ${error.message}`);
        });
    return shutdownPromise;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

client.login(process.env.DISCORD_BOT_TOKEN).catch(() => {
    console.error("[discord-bot] Falha ao logar no Discord. Verifique o DISCORD_BOT_TOKEN no arquivo .env");
    return shutdown('discord-login-failed', 1);
});
