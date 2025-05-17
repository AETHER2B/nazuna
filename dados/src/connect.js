/*
═════════════════════════════
  Nazuna - Conexão WhatsApp
  Autor: Hiudy
  Revisão: 17/05/2025
═════════════════════════════
*/

const { Boom } = require('@hapi/boom');
const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, proto, makeInMemoryStore } = require('baileys');
const NodeCache = require('@cacheable/node-cache');
const readline = require('readline');
const { execSync } = require('child_process');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, '..', 'database', 'qr-code');
const DATABASE_DIR = path.join(__dirname, '..', 'database', 'grupos');
const msgRetryCounterCache = new Map();
const { prefixo, nomebot, nomedono, numerodono } = require('./config.json');

const ask = (question) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
};

const groupCache = new NodeCache({ stdTTL: 300, useClones: false });
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

async function startNazu() {
  try {
    await fs.mkdir(DATABASE_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    async function getMessage(key) {
      if (!store) return proto.Message.fromObject({});
      const msg = await store.loadMessage(key.remoteJid, key.id).catch(() => null);
      return msg?.message || proto.Message.fromObject({});
    };

    const nazu = makeWASocket({
      countryCode: 'BR',
      auth: { 
        creds: state.creds, 
        keys: makeCacheableSignalKeyStore(state.keys, logger) 
      },
      printQRInTerminal: !process.argv.includes('--code'),
      syncFullHistory: false,
      downloadHistory: false,
      markOnlineOnConnect: false,
      fireInitQueriesEarly: false,
      fireInitQueries: false,
      msgRetryCounterCache,
      connectTimeoutMs: 180000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 1000,
      generateHighQualityLinkPreview: false,
      logger,
      getMessage,
      shouldSyncHistoryMessage: () => false,
      cachedGroupMetadata: (jid) => groupCache.get(jid) || null,
      browser: ['Ubuntu', 'Edge', '110.0.1587.56']
    });

    if (process.argv.includes('--code') && !nazu.authState.creds.registered) {
      let phoneNumber = await ask('📞 Digite seu número (com DDD e DDI, ex: +5511999999999): \n\n');
      phoneNumber = phoneNumber.replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(phoneNumber)) {
        console.log('❌ Número inválido! Deve ter entre 10 e 15 dígitos.');
        process.exit(1);
      }
      const code = await nazu.requestPairingCode(phoneNumber, 'N4ZUN4V2');
      console.log(`🔢 Seu código de pareamento: ${code}`);
      console.log('📲 No WhatsApp, vá em "Aparelhos Conectados" -> "Conectar com Número de Telefone" e insira o código.');
    }

    store.bind(nazu.ev);
    nazu.ev.on('creds.update', saveCreds);

    nazu.ev.on('groups.update', async ([ev]) => {
      const meta = await nazu.groupMetadata(ev.id).catch(() => null);
      if (meta) groupCache.set(ev.id, meta);
    });

    nazu.ev.on('group-participants.update', async (inf) => {
      const from = inf.id;
      if (inf.participants[0].startsWith(nazu.user.id.split(':')[0])) return;

      let groupMetadata = groupCache.get(from);
      if (!groupMetadata) {
        groupMetadata = await nazu.groupMetadata(from).catch(() => null);
        if (!groupMetadata) return;
        groupCache.set(from, groupMetadata);
      }

      const groupFilePath = path.join(DATABASE_DIR, `${from}.json`);
      let jsonGp;
      try {
        jsonGp = JSON.parse(await fs.readFile(groupFilePath, 'utf-8'));
      } catch (e) {
        console.error(`Erro ao carregar JSON do grupo ${from}:`, e);
        return;
      }

      if ((inf.action === 'promote' || inf.action === 'demote') && jsonGp.x9) {
        const action = inf.action === 'promote' ? 'promovido a administrador' : 'rebaixado de administrador';
        const by = inf.author || 'alguém';
        await nazu.sendMessage(from, {
          text: `🕵️ *X9 Mode* 🕵️\n\n@${inf.participants[0].split('@')[0]} foi ${action} por @${by.split('@')[0]}!`,
          mentions: [inf.participants[0], by],
        });
      }

      if (inf.action === 'add' && jsonGp.antifake) {
        const participant = inf.participants[0];
        const countryCode = participant.split('@')[0].substring(0, 2);
        if (!['55', '35'].includes(countryCode)) {
          await nazu.groupParticipantsUpdate(from, [participant], 'remove');
          await nazu.sendMessage(from, {
            text: `🚫 @${participant.split('@')[0]} foi removido por ser de um país não permitido (antifake ativado)!`,
            mentions: [participant],
          });
        }
      }

      if (inf.action === 'add' && jsonGp.antipt) {
        const participant = inf.participants[0];
        const countryCode = participant.split('@')[0].substring(0, 3);
        if (countryCode === '351') {
          await nazu.groupParticipantsUpdate(from, [participant], 'remove');
          await nazu.sendMessage(from, {
            text: `🚫 @${participant.split('@')[0]} foi removido por ser de Portugal (antipt ativado)!`,
            mentions: [participant],
          });
        }
      }

      if (inf.action === 'add' && jsonGp.blacklist?.[inf.participants[0]]) {
        const sender = inf.participants[0];
        try {
          await nazu.groupParticipantsUpdate(from, [sender], 'remove');
          await nazu.sendMessage(from, {
            text: `🚫 @${sender.split('@')[0]} foi removido automaticamente por estar na blacklist.\nMotivo: ${jsonGp.blacklist[sender].reason}`,
            mentions: [sender],
          });
        } catch (e) {
          console.error(`Erro ao remover usuário da blacklist no grupo ${from}:`, e);
        }
        return;
      }

      if (inf.action === 'add' && jsonGp.bemvindo) {
        const sender = inf.participants[0];
        const textBv = jsonGp.textbv && jsonGp.textbv.length > 1
          ? jsonGp.textbv
          : 'Seja bem-vindo(a) #numerodele# ao #nomedogp#!\nVocê é nosso membro número: *#membros#*!';

        const welcomeText = textBv
          .replaceAll('#numerodele#', `@${sender.split('@')[0]}`)
          .replaceAll('#nomedogp#', groupMetadata.subject)
          .replaceAll('#desc#', groupMetadata.desc || '')
          .replaceAll('#membros#', groupMetadata.participants.length);

        try {
          const message = { text: welcomeText, mentions: [sender] };
          if (jsonGp.welcome?.image) {
            message.image = { url: jsonGp.welcome.image };
            message.caption = welcomeText;
          }
          await nazu.sendMessage(from, message);
        } catch (e) {
          console.error(`Erro ao enviar mensagem de boas-vindas no grupo ${from}:`, e);
        }
      }

      if (inf.action === 'remove' && jsonGp.exit?.enabled) {
        const sender = inf.participants[0];
        const exitText = jsonGp.exit.text && jsonGp.exit.text.length > 1
          ? jsonGp.exit.text
          : 'Adeus #numerodele#! 👋\nO grupo *#nomedogp#* agora tem *#membros#* membros.';

        const formattedText = exitText
          .replaceAll('#numerodele#', `@${sender.split('@')[0]}`)
          .replaceAll('#nomedogp#', groupMetadata.subject)
          .replaceAll('#desc#', groupMetadata.desc || '')
          .replaceAll('#membros#', groupMetadata.participants.length);

        try {
          const message = { text: formattedText, mentions: [sender] };
          if (jsonGp.exit?.image) {
            message.image = { url: jsonGp.exit.image };
            message.caption = formattedText;
          }
          await nazu.sendMessage(from, message);
        } catch (e) {
          console.error(`Erro ao enviar mensagem de saída no grupo ${from}:`, e);
        }
      }
    });

    nazu.ev.on('messages.upsert', async (m) => {
      if (!m.messages || !Array.isArray(m.messages) || m.type === 'append') return;
      for (const info of m.messages) {
        if (!info.message) continue;
        try {
          const indexModule = require(path.join(__dirname, 'index.js'));
          if (typeof indexModule === 'function') {
            await indexModule(nazu, info, store);
          } else {
            console.error('O módulo index.js não exporta uma função válida.');
          }
        } catch (err) {
          console.error('Erro ao processar mensagem:', err);
        }
      }
    });

    nazu.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'open') {
        console.log(
          `============================================\nBot: ${nomebot}\nPrefix: ${prefixo}\nDono: ${nomedono}\nCriador: Hiudy\n============================================\n    ✅ BOT INICIADO COM SUCESSO\n============================================`
        );
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const reasonMessages = {
          [DisconnectReason.loggedOut]: '🗑️ Sessão inválida, excluindo autenticação...',
          401: '🗑️ Sessão inválida, excluindo autenticação...',
          408: '⏰ A sessão sofreu um timeout, recarregando...',
          411: '📄 O arquivo de sessão parece incorreto, tentando recarregar...',
          428: '📡 Não foi possível manter a conexão com o WhatsApp, tentando novamente...',
          440: '🔗 Existem muitas sessões conectadas, feche algumas...',
          500: '⚙️ A sessão parece mal configurada, tentando reconectar...',
          503: '❓ Erro desconhecido, tentando reconectar...',
          515: '🔄 Reiniciando código para estabilizar conexão...',
        };

        if (reason) {
          console.log(`⚠️ Conexão fechada, motivo: ${reason} - ${reasonMessages[reason] || 'Motivo desconhecido'}`);
          if ([DisconnectReason.loggedOut, 401].includes(reason)) {
            await fs.rm(AUTH_DIR, { recursive: true, force: true });
          }
        }

        await nazu.end().catch(() => null);
        console.log('🔄 Tentando reconectar...');
        startNazu();
      }

      if (connection === 'connecting') {
        console.log('🔄 Atualizando sessão...');
      }
    });
  } catch (err) {
    console.error('Erro ao iniciar o bot:', err);
    process.exit(1);
  }
}

startNazu();