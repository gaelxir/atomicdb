import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev_secret';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_TOKEN) {
  console.error("Set DISCORD_TOKEN in .env");
  process.exit(1);
}

const DB_PATH = path.join(process.cwd(), 'storage', 'db.json');
fs.ensureFileSync(DB_PATH);

let db = { mappings: {}, deliveredReceipts: {}, deliveredPasses: {} };
try {
  db = fs.readJsonSync(DB_PATH);
  if (!db.deliveredPasses) db.deliveredPasses = {};
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
const CHECK_CHANNEL = 'check-bought';

// Product mapping with Game Pass IDs
const productMap = {
  '12345678': { 
    gamePassId: '12345678',
    filename: 'configs/configPremium.zip', 
    description: 'Premium Config',
    name: 'Premium Config'
  },
  '87654321': { 
    gamePassId: '87654321',
    filename: 'configs/configBasic.zip', 
    description: 'Basic Config',
    name: 'Basic Config'
  }
};

// Check if user owns a Game Pass
async function checkGamePassOwnership(userId, gamePassId) {
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `https://inventory.roblox.com/v1/users/${userId}/items/GamePass/${gamePassId}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    return data.data && data.data.length > 0;
  } catch (error) {
    console.error('Error checking Game Pass:', error);
    return false;
  }
}

async function assignBuyerRole(discordId) {
  try {
    if (!GUILD_ID) {
      console.error('GUILD_ID not configured in .env');
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
        reason: 'Automatic role for buyers'
      });
    }

    if (!member.roles.cache.has(buyerRole.id)) {
      await member.roles.add(buyerRole);
      return true;
    }
    
    return false;
  } catch (err) {
    console.error('Error assigning role:', err);
    return false;
  }
}

async function deliverConfig(user, product, robloxId, gamePassId) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('🎉 Config Delivered!')
      .setDescription(
        `**Product:** ${product.name}\n` +
        `**Roblox ID:** ${robloxId}\n` +
        `**Game Pass:** ${gamePassId}`
      )
      .setColor(0x00FF00)
      .setTimestamp()
      .setFooter({ text: 'Thank you for your purchase!' });

    await user.send({ embeds: [embed] });

    if (product && fs.existsSync(product.filename)) {
      await user.send({ 
        content: `📦 **Here is your ${product.description}:**`,
        files: [product.filename] 
      });
    } else {
      await user.send('⚠️ File not configured. Contact support.');
      return false;
    }

    const roleAssigned = await assignBuyerRole(user.id);
    if (roleAssigned) {
      await user.send('✅ You have been assigned the **BUYER** role in the server!');
    }

    return true;
  } catch (err) {
    console.error('Error delivering config:', err);
    return false;
  }
}

async function deliverToDiscord(discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    if (!user) return { ok: false, error: 'User not found' };

    const product = productMap[payload.productId];
    
    const embed = new EmbedBuilder()
      .setTitle('🎉 Purchase Received!')
      .setDescription(
        `**Product:** ${product ? product.name : 'Unknown'}\n` +
        `**Roblox User:** ${payload.username || 'N/A'}\n` +
        `**Purchase ID:** ${payload.receiptId}`
      )
      .setColor(0x00FF00)
      .setTimestamp()
      .setFooter({ text: 'Thank you for your purchase!' });

    await user.send({ embeds: [embed] });

    if (product && fs.existsSync(product.filename)) {
      await user.send({ 
        content: `📦 **Here is your ${product.description}:**`,
        files: [product.filename] 
      });
    } else {
      await user.send('⚠️ File not configured. Contact support.');
    }

    const roleAssigned = await assignBuyerRole(discordId);
    if (roleAssigned) {
      await user.send('✅ You have been assigned the **BUYER** role in the server!');
    }

    return { ok: true };
  } catch (err) {
    console.error('Error in deliverToDiscord:', err);
    return { ok: false, error: err.message };
  }
}

client.once('ready', async () => {
  console.log(`Bot connected as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    // Registration channel embed
    const regChannel = guild.channels.cache.find(
      (ch) => ch.name === REGISTRATION_CHANNEL && ch.isTextBased()
    );
    
    if (regChannel) {
      const embed = new EmbedBuilder()
        .setTitle('🎮 Roblox Account Registration')
        .setDescription(
          '**Welcome to the registration system!**\n\n' +
          '**To link your account:**\n' +
          '`!register <YourRobloxUsername>`\n' +
          '*Example: !register gaelxir*\n\n' +
          '**To unlink your account:**\n' +
          '`!unlink`\n\n' +
          '✅ All messages will be automatically deleted.\n' +
          '🔒 Your Roblox account will only be used to deliver your purchases.'
        )
        .setColor(0xFF0000)
        .setFooter({ text: 'Automatic Registration System | Keep the channel clean' })
        .setThumbnail(client.user.displayAvatarURL())
        .setTimestamp();

      const messages = await regChannel.messages.fetch({ limit: 10 });
      const hasEmbed = messages.some((m) => 
        m.author.id === client.user.id && 
        m.embeds.length > 0 && 
        m.embeds[0].title === embed.data.title
      );
      
      if (!hasEmbed) {
        await regChannel.send({ embeds: [embed] });
      }
    }

    // Check channel embed
    const checkChannel = guild.channels.cache.find(
      (ch) => ch.name === CHECK_CHANNEL && ch.isTextBased()
    );
    
    if (checkChannel) {
      const embed = new EmbedBuilder()
        .setTitle('✅ Check Your Purchase')
        .setDescription(
          '**Bought a Game Pass? Claim your config here!**\n\n' +
          '**How to claim:**\n' +
          '1️⃣ Make sure you\'re registered (use `#roblox-registration`)\n' +
          '2️⃣ Buy the Game Pass in Roblox\n' +
          '3️⃣ Type `!check` here\n\n' +
          '⚠️ **Important:**\n' +
          '• You can only claim each config **ONCE**\n' +
          '• You must be registered first\n' +
          '• Configs are delivered via DM\n\n' +
          '🔒 **Anti-Steal Protection Active**'
        )
        .setColor(0x00FF00)
        .setFooter({ text: 'Automatic Delivery System | One config per purchase' })
        .setThumbnail(client.user.displayAvatarURL())
        .setTimestamp();

      const messages = await checkChannel.messages.fetch({ limit: 10 });
      const hasEmbed = messages.some((m) => 
        m.author.id === client.user.id && 
        m.embeds.length > 0 && 
        m.embeds[0].title === embed.data.title
      );
      
      if (!hasEmbed) {
        await checkChannel.send({ embeds: [embed] });
      }
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isTextBased()) return;
  if (message.channel.name !== REGISTRATION_CHANNEL) return;

  const content = message.content.trim();
  const channelName = message.channel.name;

  // REGISTRATION CHANNEL COMMANDS
  if (channelName === REGISTRATION_CHANNEL) {
    // !register command
    if (content.startsWith('!register ')) {
      const args = content.split(' ');
      const robloxUsername = args.slice(1).join(' ');

      if (!robloxUsername || robloxUsername.length < 3) {
        const errorMsg = await message.reply('❌ Invalid username. Use: `!register <RobloxUsername>`');
        setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
      }

      try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`https://users.roblox.com/v1/usernames/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true })
        });
        
        const data = await response.json();
        
        if (!data.data || data.data.length === 0) {
          const errorMsg = await message.reply('❌ User not found on Roblox.');
          setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
          setTimeout(() => message.delete().catch(() => {}), 1000);
          return;
        }

        const robloxId = String(data.data[0].id);
        const displayName = data.data[0].displayName;

        db.mappings[robloxId] = message.author.id;
        saveDB();

        try {
          const checkChannelMention = message.guild.channels.cache.find(ch => ch.name === CHECK_CHANNEL);
          const embed = new EmbedBuilder()
            .setTitle('✅ Account Registered')
            .setDescription(
              `Your Roblox account has been successfully linked!\n\n` +
              `**User:** ${displayName} (@${robloxUsername})\n` +
              `**ID:** ${robloxId}\n\n` +
              `You can now buy Game Passes and claim them in ${checkChannelMention ? `<#${checkChannelMention.id}>` : '#check-bought'}`
            )
            .setColor(0x00FF00)
            .setTimestamp();
          
          await message.author.send({ embeds: [embed] });
        } catch (err) {
          console.error('Could not send DM:', err);
        }

        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;

      } catch (error) {
        console.error('Error fetching user:', error);
        const errorMsg = await message.reply('❌ Error fetching user. Please try again.');
        setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
      }
    }

    // !unlink command
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
        const embed = new EmbedBuilder()
          .setTitle('⚠️ Account Unlinked')
          .setDescription(
            `Your Roblox account **${robloxId}** has been unlinked.\n\n` +
            `You can register another account anytime with \`!register\``
          )
          .setColor(0xFFA500)
          .setTimestamp();
        
        await message.author.send({ embeds: [embed] });
      } catch (err) {}

      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    // Delete any other message in registration channel
    setTimeout(() => message.delete().catch(() => {}), 1000);
    return;
  }

  // CHECK CHANNEL COMMANDS
  if (channelName === CHECK_CHANNEL) {
    if (content === '!check') {
      const userId = message.author.id;
      
      // Find Roblox ID
      const robloxId = Object.keys(db.mappings).find((id) => db.mappings[id] === userId);
      
      if (!robloxId) {
        const regChannel = message.guild.channels.cache.find(ch => ch.name === REGISTRATION_CHANNEL);
        const errorMsg = await message.reply(
          '❌ You need to register first! Go to ' + 
          (regChannel ? `<#${regChannel.id}>` : '#roblox-registration') + 
          ' and use `!register <username>`'
        );
        setTimeout(() => errorMsg.delete().catch(() => {}), 10000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
      }

      const loadingMsg = await message.reply('🔍 Checking your Roblox inventory...');

      let foundAny = false;

      for (const [productId, product] of Object.entries(productMap)) {
        const deliveryKey = `${robloxId}_${productId}`;
        
        // Check if already delivered
        if (db.deliveredPasses[deliveryKey]) {
          continue;
        }

        // Check if user owns the Game Pass
        const ownsPass = await checkGamePassOwnership(robloxId, product.gamePassId);
        
        if (ownsPass) {
          foundAny = true;
          
          const success = await deliverConfig(message.author, product, robloxId, product.gamePassId);
          
          if (success) {
            db.deliveredPasses[deliveryKey] = {
              productId,
              robloxId,
              discordId: userId,
              deliveredAt: new Date().toISOString()
            };
            saveDB();
            
            await loadingMsg.edit(`✅ **${product.name}** delivered! Check your DMs.`);
          } else {
            await loadingMsg.edit(`❌ Error delivering **${product.name}**. Contact support.`);
          }
          
          setTimeout(() => loadingMsg.delete().catch(() => {}), 5000);
          setTimeout(() => message.delete().catch(() => {}), 1000);
          return;
        }
      }

      if (!foundAny) {
        await loadingMsg.edit('❌ No Game Pass found in your inventory or already claimed.');
        setTimeout(() => loadingMsg.delete().catch(() => {}), 10000);
      }

      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    // Delete any other message in check channel
    setTimeout(() => message.delete().catch(() => {}), 1000);
    return;
  }
});

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
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));