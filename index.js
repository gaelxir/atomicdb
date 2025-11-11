import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev_secret';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // Añade esto a tu .env

if (!DISCORD_TOKEN) {
  console.error("Set DISCORD_TOKEN in .env");
  process.exit(1);
}

const DB_PATH = path.join(process.cwd(), 'storage', 'db.json');
fs.ensureFileSync(DB_PATH);

let db = { mappings: {}, deliveredReceipts: {} };
try {
  db = fs.readJsonSync(DB_PATH);
} catch (e) {
  fs.writeJsonSync(DB_PATH, db, { spaces: 2 });
}

function saveDB() {
  fs.writeJsonSync(DB_PATH, db, { spaces: 2 });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
});

const REGISTRATION_CHANNEL = 'roblox-registration';

// Mapeo de productos
const productMap = {
  '12345678': { 
    filename: 'configs/configPremium.zip', 
    description: 'Premium Config',
    name: 'Config Premium'
  },
  '87654321': { 
    filename: 'configs/configBasic.zip', 
    description: 'Basic Config',
    name: 'Config Básico'
  }
};

client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);

  client.guilds.cache.forEach(async (guild) => {
    const channel = guild.channels.cache.find(
      (ch) => ch.name === REGISTRATION_CHANNEL && ch.isTextBased()
    );
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('🎮 Registro de Cuenta Roblox')
      .setDescription(
        '**¡Bienvenido al sistema de registro!**\n\n' +
        '**Para vincular tu cuenta:**\n' +
        '`!register <TuUsuarioDeRoblox>`\n' +
        '*Ejemplo: !register gaelxir*\n\n' +
        '**Para desvincular tu cuenta:**\n' +
        '`!unlink`\n\n' +
        '✅ Todos los mensajes serán eliminados automáticamente.\n' +
        '🔒 Tu cuenta de Roblox solo se usará para entregarte tus compras.'
      )
      .setColor(0xFF0000)
      .setFooter({ text: 'Sistema Automático de Registro | Mantén el canal limpio' })
      .setThumbnail(client.user.displayAvatarURL())
      .setTimestamp();

    const messages = await channel.messages.fetch({ limit: 10 });
    const hasEmbed = messages.some((m) => 
      m.author.id === client.user.id && 
      m.embeds.length > 0 && 
      m.embeds[0].title === embed.data.title
    );
    
    if (!hasEmbed) {
      await channel.send({ embeds: [embed] });
    }
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isTextBased()) return;
  if (message.channel.name !== REGISTRATION_CHANNEL) return;

  const content = message.content.trim();

  // Comando !register
  if (content.startsWith('!register ')) {
    const args = content.split(' ');
    const robloxUsername = args.slice(1).join(' ');

    if (!robloxUsername || robloxUsername.length < 3) {
      const errorMsg = await message.reply('❌ Usuario inválido. Usa: `!register <UsuarioRoblox>`');
      setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    // Obtener ID de Roblox desde username
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(`https://users.roblox.com/v1/usernames/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true })
      });
      
      const data = await response.json();
      
      if (!data.data || data.data.length === 0) {
        const errorMsg = await message.reply('❌ No se encontró ese usuario en Roblox.');
        setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
      }

      const robloxId = String(data.data[0].id);
      const displayName = data.data[0].displayName;

      db.mappings[robloxId] = message.author.id;
      saveDB();

      try {
        const embed = new EmbedBuilder()
          .setTitle('✅ Cuenta Registrada')
          .setDescription(
            `Tu cuenta de Roblox ha sido vinculada exitosamente!\n\n` +
            `**Usuario:** ${displayName} (@${robloxUsername})\n` +
            `**ID:** ${robloxId}\n\n` +
            `Ahora puedes comprar configs en el juego y las recibirás aquí.`
          )
          .setColor(0x00FF00)
          .setTimestamp();
        
        await message.author.send({ embeds: [embed] });
      } catch (err) {
        console.error('No se pudo enviar DM:', err);
      }

      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;

    } catch (error) {
      console.error('Error al buscar usuario:', error);
      const errorMsg = await message.reply('❌ Error al buscar el usuario. Intenta nuevamente.');
      setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }
  }

  // Comando !unlink
  if (content === '!unlink') {
    const userId = message.author.id;
    const robloxId = Object.keys(db.mappings).find((id) => db.mappings[id] === userId);

    if (!robloxId) {
      const errorMsg = await message.reply('❌ No tienes ninguna cuenta de Roblox vinculada.');
      setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    delete db.mappings[robloxId];
    saveDB();

    try {
      const embed = new EmbedBuilder()
        .setTitle('⚠️ Cuenta Desvinculada')
        .setDescription(
          `Tu cuenta de Roblox **${robloxId}** ha sido desvinculada.\n\n` +
          `Puedes registrar otra cuenta cuando quieras con \`!register\``
        )
        .setColor(0xFFA500)
        .setTimestamp();
      
      await message.author.send({ embeds: [embed] });
    } catch (err) {}

    setTimeout(() => message.delete().catch(() => {}), 1000);
    return;
  }

  // Eliminar cualquier otro mensaje
  setTimeout(() => message.delete().catch(() => {}), 1000);
});

async function assignBuyerRole(discordId) {
  try {
    if (!GUILD_ID) {
      console.error('GUILD_ID no configurado en .env');
      return false;
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) return false;

    const member = await guild.members.fetch(discordId);
    if (!member) return false;

    let buyerRole = guild.roles.cache.find(role => role.name === 'BUYER');
    
    if (!buyerRole) {
      buyerRole = await guild.roles.create({
        name: 'BUYER',
        color: 0x00FF00,
        reason: 'Rol automático para compradores'
      });
    }

    if (!member.roles.cache.has(buyerRole.id)) {
      await member.roles.add(buyerRole);
      return true;
    }
    
    return false;
  } catch (err) {
    console.error('Error asignando rol:', err);
    return false;
  }
}

async function deliverToDiscord(discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    if (!user) return { ok: false, error: 'Usuario no encontrado' };

    const product = productMap[payload.productId];
    
    const embed = new EmbedBuilder()
      .setTitle('🎉 ¡Compra Recibida!')
      .setDescription(
        `**Producto:** ${product ? product.name : 'Desconocido'}\n` +
        `**Usuario Roblox:** ${payload.username || 'N/A'}\n` +
        `**ID de Compra:** ${payload.receiptId}`
      )
      .setColor(0x00FF00)
      .setTimestamp()
      .setFooter({ text: 'Gracias por tu compra!' });

    await user.send({ embeds: [embed] });

    // Enviar archivo si existe
    if (product && fs.existsSync(product.filename)) {
      await user.send({ 
        content: `📦 **Aquí está tu ${product.description}:**`,
        files: [product.filename] 
      });
    } else {
      await user.send('⚠️ Archivo no configurado. Contacta con soporte.');
    }

    // Asignar rol BUYER
    const roleAssigned = await assignBuyerRole(discordId);
    if (roleAssigned) {
      await user.send('✅ Se te ha asignado el rol **BUYER** en el servidor!');
    }

    return { ok: true };
  } catch (err) {
    console.error('Error en deliverToDiscord:', err);
    return { ok: false, error: err.message };
  }
}

const app = express();
app.use(express.json());

app.post('/api/payment', async (req, res) => {
  const secret = req.header('x-shared-secret');
  if (secret !== SHARED_SECRET) return res.status(401).send('Unauthorized');

  const payload = req.body;
  if (!payload.userId || !payload.productId || !payload.receiptId) {
    return res.status(400).send('Invalid payload');
  }

  if (db.deliveredReceipts[payload.receiptId]) {
    return res.status(200).send('Already delivered');
  }

  const discordId = payload.discordId || db.mappings[String(payload.userId)];
  if (!discordId) {
    db.deliveredReceipts[payload.receiptId] = { status: 'pending', payload };
    saveDB();
    return res.status(200).send('No Discord ID found');
  }

  const result = await deliverToDiscord(discordId, payload);
  db.deliveredReceipts[payload.receiptId] = {
    status: result.ok ? 'delivered' : 'failed',
    payload,
    deliveredAt: new Date().toISOString()
  };
  saveDB();

  res.status(200).send(result.ok ? 'Delivered' : 'Delivery failed');
});

app.post('/map', (req, res) => {
  const secret = req.header('x-shared-secret');
  if (secret !== SHARED_SECRET) return res.status(401).send('Unauthorized');

  const { robloxId, discordId } = req.body;
  if (!robloxId || !discordId) return res.status(400).send('Missing fields');

  db.mappings[String(robloxId)] = discordId;
  saveDB();
  res.send({ ok: true });
});

app.get('/health', (req, res) => {
  res.send({ status: 'ok', bot: client.user?.tag });
});

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));