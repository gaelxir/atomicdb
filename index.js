import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev_secret';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

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
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

const REGISTRATION_CHANNEL = 'roblox-registration';

client.once('ready', async () => {
  console.log(`Bot connected as ${client.user.tag}`);

  client.guilds.cache.forEach(async (guild) => {
    const channel = guild.channels.cache.find(
      (ch) => ch.name === REGISTRATION_CHANNEL && ch.isTextBased()
    );
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('🎮 Roblox Account Registration')
      .setDescription(
        'Welcome to Roblox account registration!\n\n' +
        '**To link your account:**\n' +
        '`!link <YourRobloxID>`\n\n' +
        '**To unlink your account:**\n' +
        '`!unlink`\n\n' +
        '✅ All messages will be automatically deleted to keep the channel clean.\n' +
        '🔒 Your RobloxID will only be used to deliver your files and will not be public.'
      )
      .setColor(0x1ABC9C)
      .setFooter({ text: 'Automatic Registration System | Keep the channel clean' })
      .setThumbnail(client.user.displayAvatarURL());

    const messages = await channel.messages.fetch({ limit: 10 });
    if (!messages.some((m) => m.embeds.length > 0 && m.embeds[0].title === embed.data.title)) {
      await channel.send({ embeds: [embed] });
    }
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isTextBased()) return;
  if (message.channel.name !== REGISTRATION_CHANNEL) return;

  const content = message.content.trim();

  if (content.startsWith('!link ')) {
    const args = content.split(' ');
    const robloxId = args[1];

    if (!robloxId || isNaN(Number(robloxId))) {
      const errorMsg = await message.reply('❌ Invalid Roblox ID. Use: `!link <RobloxID>`');
      setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    db.mappings[String(robloxId)] = message.author.id;
    saveDB();

    try {
      await message.author.send(
        `✅ Your Roblox account **${robloxId}** has been successfully **linked** to your Discord.`
      );
    } catch (err) {}

    setTimeout(() => message.delete().catch(() => {}), 1000);
    return;
  }

  if (content === '!unlink') {
    const userId = message.author.id;
    const robloxId = Object.keys(db.mappings).find((id) => db.mappings[id] === userId);

    if (!robloxId) {
      const errorMsg = await message.reply('❌ You do not have any linked Roblox account.');
      setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    delete db.mappings[robloxId];
    saveDB();

    try {
      await message.author.send(
        `⚠️ Your Roblox account **${robloxId}** has been **unlinked**.`
      );
    } catch (err) {}

    setTimeout(() => message.delete().catch(() => {}), 1000);
    return;
  }

  setTimeout(() => message.delete().catch(() => {}), 1000);
});

const productMap = {
  '12345678': { filename: 'configs/configPremium.zip', description: 'Premium config' }
};

async function deliverToDiscord(discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    if (!user) return { ok: false, error: 'User not found' };

    const messageText =
      '🎉 **Purchase received**\n' +
      `Roblox User: ${payload.username}\n` +
      `Product: ${payload.productId}\n` +
      `Receipt: ${payload.receiptId}`;

    await user.send(messageText);

    if (productMap[payload.productId] && fs.existsSync(productMap[payload.productId].filename)) {
      await user.send({ files: [productMap[payload.productId].filename] });
    } else {
      await user.send('⚠️ File not configured. Contact support.');
    }

    return { ok: true };
  } catch (err) {
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

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
