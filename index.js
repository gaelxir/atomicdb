import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev_secret';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const JSONBIN_ID = "691fa23cae596e708f662d93";
const JSONBIN_KEY = "$2a$10$dJuOq/7kOOymFcfehIVqSefrh9C4MabSIVQl1UiwnyQDN7gde7kLS";


if (!DISCORD_TOKEN) {
  console.error("Set DISCORD_TOKEN in .env");
  process.exit(1);
}

// ---------------- DEBUG HELPERS ----------------
const DEBUG = true;
function dbg(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

// capture fatal/unhandled errors (useful in Railway)
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection:', err && (err.stack || err));
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && (err.stack || err));
});
dbg('Debugging enabled');
// ------------------------------------------------

// ------------- JSONBin-backed DB (with cache) -------------
/*
  Design:
  - loadDB(): GET from JSONBin v3 (/latest)
  - saveDB(): update local cache and schedule flush (debounced)
  - flushDBToJsonBin(): actual PUT to JSONBin
  - cache ttl minimizes requests and avoids rate limits
*/

let db = { mappings: {}, deliveredReceipts: {}, deliveredPasses: {} };
let dbCache = null; // cached copy
let lastFetchAt = 0;
const CACHE_TTL_MS = 5000; // 5s cache TTL
let flushTimer = null;
let flushing = false;

async function fetchJsonBin(method, url, body = null) {
  const fetch = (await import('node-fetch')).default;
  const headers = {
    "X-Master-Key": JSONBIN_KEY,
    "Content-Type": "application/json"
  };
  const opts = {
    method,
    headers
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => null);
    const err = new Error(`JSONBin HTTP ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function loadDB() {
  try {
    dbg('loadDB -> fetching from JSONBin:', JSONBIN_ID);
    const res = await fetchJsonBin('GET', `https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`);
    const record = res && res.record ? res.record : null;
    if (!record) {
      dbg('loadDB -> no record found, using default empty DB');
      db = { mappings: {}, deliveredReceipts: {}, deliveredPasses: {} };
    } else {
      db = record;
      // safety defaults
      if (!db.mappings) db.mappings = {};
      if (!db.deliveredReceipts) db.deliveredReceipts = {};
      if (!db.deliveredPasses) db.deliveredPasses = {};
    }
    dbCache = JSON.parse(JSON.stringify(db));
    lastFetchAt = Date.now();
    dbg('loadDB -> DB loaded from JSONBin, keys:', Object.keys(db.mappings).length, Object.keys(db.deliveredReceipts).length, Object.keys(db.deliveredPasses).length);
  } catch (err) {
    console.error('loadDB -> error loading DB from JSONBin:', err && (err.stack || err));
    // fallback to empty db (we will create the bin contents on first save)
    db = { mappings: {}, deliveredReceipts: {}, deliveredPasses: {} };
    dbCache = JSON.parse(JSON.stringify(db));
  }
}

async function flushDBToJsonBin(retries = 3) {
  if (flushing) {
    dbg('flushDBToJsonBin -> already flushing, skipping');
    return;
  }
  flushing = true;
  const payload = dbCache || db;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      dbg('flushDBToJsonBin -> PUT to JSONBin attempt', attempt);
      await fetchJsonBin('PUT', `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`, payload);
      dbg('flushDBToJsonBin -> successfully saved to JSONBin');
      flushing = false;
      return;
    } catch (err) {
      console.error(`flushDBToJsonBin -> attempt ${attempt} failed:`, err && (err.message || err));
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      } else {
        console.error('flushDBToJsonBin -> all attempts failed, will retry later');
        flushing = false;
        return;
      }
    }
  }
  flushing = false;
}

function scheduleFlush() {
  if (flushTimer) return; // already scheduled
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!dbCache) return;
    await flushDBToJsonBin();
  }, 1000); // debounce 1s
}

/**
 * saveDB:
 * - Updates the cached db (dbCache) immediately
 * - Schedules a flush to JSONBin (non-blocking)
 * - Returns a resolved promise so callers can await it without blocking for the remote save
 */
async function saveDB() {
  try {
    dbCache = JSON.parse(JSON.stringify(db));
    lastFetchAt = Date.now();
    scheduleFlush();
    dbg('saveDB -> cache updated, flush scheduled');
  } catch (err) {
    console.error('saveDB -> error updating cache:', err && (err.stack || err));
  }
  return Promise.resolve();
}

// Expose a helper to force sync save (rarely needed)
async function forceSaveDB() {
  try {
    dbCache = JSON.parse(JSON.stringify(db));
    lastFetchAt = Date.now();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushDBToJsonBin(5);
  } catch (err) {
    console.error('forceSaveDB -> error:', err && (err.stack || err));
  }
}

// ------------------------------------------------------------

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
const PROOFS_CHANNEL = 'proofs';
const BANNER_URL = 'https://media.discordapp.net/attachments/1435421930084634624/1437892661766783006/bannmn.png?ex=6914e565&is=691393e5&hm=ee384f334d57bed7e9d2b3c00df20970a0f511d24c5f0bd9b341cc9414b93f76&=&format=webp&quality=lossless&width=1872&height=378'; // Pon tu link del banner aquí

// Product mapping with Game Pass IDs
const productMap = {
  '1581370634': { 
    gamePassId: '1581370634',
    filename: 'configs/deelegit.zip', 
    description: 'THE BEST Dee hood LEGIT CFG',
    name: 'Dee Hood Legit CFG'
  },
  '1577628225': { 
    gamePassId: '1577628225',
    filename: 'configs/deerage.zip', 
    description: 'THE BEST Dee hood RAGE CFG',
    name: 'Dee Hood Rage CFG'
  },
    '1583049994': { 
    gamePassId: '1583049994',
    filename: 'configs/arage.zip', 
    description: 'THE BEST Ar hood RAGE CFG',
    name: 'Ar Hood Rage CFG'
  }
};

// Check if user owns a Game Pass
async function checkGamePassOwnership(userId, gamePassId) {
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `https://inventory.roblox.com/v1/users/${userId}/items/GamePass/${gamePassId}`;
    dbg('checkGamePassOwnership -> fetching URL:', url);

    const response = await fetch(url);
    dbg('checkGamePassOwnership -> HTTP status:', response.status);

    let data;
    try {
      data = await response.json();
      dbg('checkGamePassOwnership -> parsed JSON response:', JSON.stringify(data));
    } catch (parseErr) {
      const text = await response.text().catch(() => null);
      dbg('checkGamePassOwnership -> failed to parse JSON, raw text:', text);
      throw parseErr;
    }

    const owns = data.data && data.data.length > 0;
    dbg(`checkGamePassOwnership -> user ${userId} owns pass ${gamePassId}?`, owns);
    return owns;
  } catch (error) {
    console.error('Error checking Game Pass:', error && (error.stack || error));
    return false;
  }
}

// Send proof message to #proofs channel
async function sendProofMessage(guild, user, product, robloxId) {
  try {
    const proofsChannel = guild.channels.cache.find(ch => ch.name === PROOFS_CHANNEL && ch.isTextBased());
    
    if (!proofsChannel) {
      dbg('sendProofMessage -> proofs channel not found in guild:', guild.id);
      return false;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎊 AUTOMATIC SYSTEM NEW BUY!')
      .setDescription(
        `**✨ SUCCESSFUL PURCHASE ✨**\n\n` +
        `**Buyer:** ${user} (${user.tag})\n` +
        `**Product:** ${product.name}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**💬 Thank you for your purchase!**\n` +
        `We appreciate your trust in our configs! Your ${product.name} has been delivered to your DMs.\n\n` +
        `**🎯 Need Help?**\n` +
        `If you have any questions, issues, or need support with your config, feel free to:\n` +
        `• Open a support ticket\n` +
        `• Contact our support team\n` +
        `• Check our tutorials and guides\n\n` +
        `**🔥 Enjoy your config and dominate the game!**\n` +
        `We hope you love your new setup. Good luck out there! 🎮\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Delivered by Automatic Config Delivery System*`
      )
      .setColor(0x005CFA)
      .setImage(BANNER_URL)
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: `Purchase ID: ${Date.now()}` })
      .setTimestamp();

    await proofsChannel.send({ 
      content: '@everyone',
      embeds: [embed] 
    });
    dbg('sendProofMessage -> proof posted in channel for user:', user.id, 'product:', product.name);
    return true;
  } catch (err) {
    console.error('Error sending proof message:', err && (err.stack || err));
    dbg('sendProofMessage -> error:', err && (err.message || err));
    return false;
  }
}

async function assignBuyerRole(discordId) {
  try {
    dbg('assignBuyerRole -> start for discordId:', discordId);
    if (!GUILD_ID) {
      console.error('GUILD_ID not configured in .env');
      dbg('assignBuyerRole -> aborted: no GUILD_ID');
      return false;
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) {
      dbg('assignBuyerRole -> guild not found for GUILD_ID:', GUILD_ID);
      return false;
    }

    const member = await guild.members.fetch(discordId);
    if (!member) {
      dbg('assignBuyerRole -> member not found for discordId:', discordId);
      return false;
    }

    let buyerRole = guild.roles.cache.find(role => role.name === 'BUYER');
    
    if (!buyerRole) {
      dbg('assignBuyerRole -> BUYER role not found, creating it...');
      buyerRole = await guild.roles.create({
        name: 'BUYER',
        color: 0x00FF00,
        reason: 'Automatic role for buyers'
      });
      dbg('assignBuyerRole -> BUYER role created with id:', buyerRole.id);
    } else {
      dbg('assignBuyerRole -> Found existing BUYER role id:', buyerRole.id);
    }

    if (!member.roles.cache.has(buyerRole.id)) {
      await member.roles.add(buyerRole);
      dbg('assignBuyerRole -> role added to member:', discordId);
      return true;
    }
    
    dbg('assignBuyerRole -> member already had BUYER role:', discordId);
    return false;
  } catch (err) {
    console.error('Error assigning role:', err && (err.stack || err));
    dbg('assignBuyerRole -> error assigning role for', discordId, err && (err.message || err));
    return false;
  }
}

async function deliverConfig(user, product, robloxId, gamePassId, guild) {
  try {
    dbg('deliverConfig -> start for user:', user.id, 'product:', product?.name);
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
    dbg('deliverConfig -> embed DM sent to', user.id);

    if (product && fs.existsSync(product.filename)) {
      await user.send({ 
        content: `📦 **Here is your ${product.description}:**`,
        files: [product.filename] 
      });
      dbg('deliverConfig -> file sent:', product.filename);
    } else {
      await user.send('⚠️ File not configured. Contact support.');
      dbg('deliverConfig -> missing file for product:', product && product.filename);
      return false;
    }

    const roleAssigned = await assignBuyerRole(user.id);
    dbg('deliverConfig -> assignBuyerRole result:', roleAssigned);
    if (roleAssigned) {
      await user.send('✅ You have been assigned the **BUYER** role in the server!');
      dbg('deliverConfig -> notified user about role assignment');
    }

    // Send proof message to #proofs channel
    if (guild) {
      await sendProofMessage(guild, user, product, robloxId);
    }

    dbg('deliverConfig -> success for user:', user.id);
    return true;
  } catch (err) {
    console.error('Error delivering config:', err && (err.stack || err));
    dbg('deliverConfig -> error for user:', user && user.id, err && (err.message || err));
    return false;
  }
}

async function deliverToDiscord(discordId, payload) {
  try {
    dbg('deliverToDiscord -> start for discordId:', discordId, 'payload.receiptId:', payload.receiptId);
    const user = await client.users.fetch(discordId);
    if (!user) {
      dbg('deliverToDiscord -> user not found for discordId:', discordId);
      return { ok: false, error: 'User not found' };
    }

    const product = productMap[payload.productId];
    dbg('deliverToDiscord -> resolved product:', product ? product.name : 'UNKNOWN');

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
    dbg('deliverToDiscord -> sent purchase embed to user:', discordId);

    if (product && fs.existsSync(product.filename)) {
      await user.send({ 
        content: `📦 **Here is your ${product.description}:**`,
        files: [product.filename] 
      });
      dbg('deliverToDiscord -> sent file to user:', product.filename);
    } else {
      await user.send('⚠️ File not configured. Contact support.');
      dbg('deliverToDiscord -> file missing for product:', product && product.filename);
    }

    const roleAssigned = await assignBuyerRole(discordId);
    dbg('deliverToDiscord -> assignBuyerRole result:', roleAssigned);
    if (roleAssigned) {
      await user.send('✅ You have been assigned the **BUYER** role in the server!');
      dbg('deliverToDiscord -> notified user about role assignment');
    }

    // Send proof message to #proofs channel
    if (GUILD_ID && product) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        if (guild) {
          await sendProofMessage(guild, user, product, payload.userId);
        }
      } catch (guildErr) {
        dbg('deliverToDiscord -> could not send proof message:', guildErr && guildErr.message);
      }
    }

    dbg('deliverToDiscord -> finished OK for discordId:', discordId);
    return { ok: true };
  } catch (err) {
    console.error('Error in deliverToDiscord:', err && (err.stack || err));
    dbg('deliverToDiscord -> error for discordId:', discordId, err && (err.message || err));
    return { ok: false, error: err.message };
  }
}

client.once('ready', async () => {
  console.log(`Bot connected as ${client.user.tag}`);
  dbg('ready -> client.user:', client.user?.tag);

  for (const guild of client.guilds.cache.values()) {
    dbg('ready -> setting up guild:', guild.id, guild.name);
    // Registration channel embed
    const regChannel = guild.channels.cache.find(
      (ch) => ch.name === REGISTRATION_CHANNEL && ch.isTextBased()
    );
    
    if (regChannel) {
      dbg('ready -> found registration channel in guild:', guild.id);
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
        dbg('ready -> posted registration embed in channel:', regChannel.id);
      } else {
        dbg('ready -> registration embed already present in channel:', regChannel.id);
      }
    }

    // Check channel embed
    const checkChannel = guild.channels.cache.find(
      (ch) => ch.name === CHECK_CHANNEL && ch.isTextBased()
    );
    
    if (checkChannel) {
      dbg('ready -> found check channel in guild:', guild.id);
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
        dbg('ready -> posted check embed in channel:', checkChannel.id);
      } else {
        dbg('ready -> check embed already present in channel:', checkChannel.id);
      }
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isTextBased()) return;
  // Log every incoming message in channels we care about (critical)
  dbg('messageCreate -> author:', message.author.tag, 'channel:', message.channel.name, 'content:', message.content);

 if (![REGISTRATION_CHANNEL, CHECK_CHANNEL].includes(message.channel.name)) return;

  const content = message.content.trim();
  const channelName = message.channel.name;

  // REGISTRATION CHANNEL COMMANDS
  if (channelName === REGISTRATION_CHANNEL) {
    // !register command
    if (content.startsWith('!register ')) {
      dbg('!register command detected from', message.author.tag, 'content:', content);
      const args = content.split(' ');
      const robloxUsername = args.slice(1).join(' ');

      if (!robloxUsername || robloxUsername.length < 3) {
        const errorMsg = await message.reply('❌ Invalid username. Use: `!register <RobloxUsername>`');
        setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        dbg('!register -> invalid username provided by', message.author.tag);
        return;
      }

      try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`https://users.roblox.com/v1/usernames/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true })
        });
        
        dbg('!register -> Roblox users API status:', response.status);
        const data = await response.json();
        dbg('!register -> Roblox users API response:', JSON.stringify(data));

        if (!data.data || data.data.length === 0) {
          const errorMsg = await message.reply('❌ User not found on Roblox.');
          setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
          setTimeout(() => message.delete().catch(() => {}), 1000);
          dbg('!register -> roblox user not found for username:', robloxUsername);
          return;
        }

        const robloxId = String(data.data[0].id);
        const displayName = data.data[0].displayName;

        db.mappings[robloxId] = message.author.id;
        await saveDB();
        dbg('!register -> mapping saved:', robloxId, '=>', message.author.id);

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
          dbg('!register -> DM sent to user:', message.author.id);
        } catch (err) {
          console.error('Could not send DM:', err && (err.stack || err));
          dbg('!register -> could not DM user:', message.author.id, err && (err.message || err));
        }

        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;

      } catch (error) {
        console.error('Error fetching user:', error && (error.stack || err));
        dbg('!register -> error fetching roblox user for username:', robloxUsername, error && (error.message || error));
        const errorMsg = await message.reply('❌ Error fetching user. Please try again.');
        setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
      }
    }

    // !unlink command
    if (content === '!unlink') {
      dbg('!unlink command detected from', message.author.tag);
      const userId = message.author.id;
      const robloxId = Object.keys(db.mappings).find((id) => db.mappings[id] === userId);

      if (!robloxId) {
        const errorMsg = await message.reply('❌ You do not have any linked Roblox account.');
        setTimeout(() => errorMsg.delete().catch(() => {}), 5000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        dbg('!unlink -> no mapping found for user:', userId);
        return;
      }

      delete db.mappings[robloxId];
      await saveDB();
      dbg('!unlink -> mapping removed for robloxId:', robloxId);

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
        dbg('!unlink -> DM sent to user about unlink:', userId);
      } catch (err) {
        dbg('!unlink -> could not DM user after unlink:', userId, err && (err.message || err));
      }

      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    // Delete any other message in registration channel
    dbg('messageCreate -> deleting non-command message in registration channel from', message.author.tag);
    setTimeout(() => message.delete().catch(() => {}), 1000);
    return;
  }

  // CHECK CHANNEL COMMANDS
  if (message.channel.name === CHECK_CHANNEL) {
    const contentCheck = message.content.trim();
    if (contentCheck === '!check') {
      dbg('!check invoked by', message.author.tag, message.author.id);
      const userId = message.author.id;
      
      // Find Roblox ID
      const robloxId = Object.keys(db.mappings).find((id) => db.mappings[id] === userId);
      dbg('!check -> mapped robloxId for discord user:', userId, '=>', robloxId);
      
      if (!robloxId) {
        const regChannel = message.guild.channels.cache.find(ch => ch.name === REGISTRATION_CHANNEL);
        const errorMsg = await message.reply(
          '❌ You need to register first! Go to ' + 
          (regChannel ? `<#${regChannel.id}>` : '#roblox-registration') + 
          ' and use `!register <username>`'
        );
        setTimeout(() => errorMsg.delete().catch(() => {}), 10000);
        setTimeout(() => message.delete().catch(() => {}), 1000);
        dbg('!check -> aborted: no linked robloxId for discord user:', userId);
        return;
      }

      const loadingMsg = await message.reply('🔍 Checking your Roblox inventory...');
      dbg('!check -> checking passes for robloxId:', robloxId);

      let foundAny = false;

      for (const [productId, product] of Object.entries(productMap)) {
        dbg('!check -> iterating product:', productId, product.name);
        const deliveryKey = `${robloxId}_${productId}`;
        
        // Check if already delivered
        if (db.deliveredPasses[deliveryKey]) {
          dbg('!check -> already delivered key, skipping:', deliveryKey);
          continue;
        }

        // Check if user owns the Game Pass
        dbg('!check -> calling checkGamePassOwnership for', product.gamePassId);
        const ownsPass = await checkGamePassOwnership(robloxId, product.gamePassId);
        dbg('!check -> checkGamePassOwnership returned:', ownsPass, 'for', product.gamePassId);
        
        if (ownsPass) {
          foundAny = true;
          dbg('!check -> user owns pass, delivering product:', product.name);
          
          const success = await deliverConfig(message.author, product, robloxId, product.gamePassId, message.guild);
          
          if (success) {
            db.deliveredPasses[deliveryKey] = {
              productId,
              robloxId,
              discordId: userId,
              deliveredAt: new Date().toISOString()
            };
            await saveDB();
            dbg('!check -> delivery recorded in DB for key:', deliveryKey);
            
            await loadingMsg.edit(`✅ **${product.name}** delivered! Check your DMs.`);
            dbg('!check -> loading message edited to success for', message.author.id);
          } else {
            await loadingMsg.edit(`❌ Error delivering **${product.name}**. Contact support.`);
            dbg('!check -> delivery failed for product:', product.name, 'user:', message.author.id);
          }
          
          setTimeout(() => loadingMsg.delete().catch(() => {}), 5000);
          setTimeout(() => message.delete().catch(() => {}), 1000);
          return;
        }
      }

      if (!foundAny) {
        dbg('!check -> no passes found or already claimed for robloxId:', robloxId);
        await loadingMsg.edit('❌ No Game Pass found in your inventory or already claimed.');
        setTimeout(() => loadingMsg.delete().catch(() => {}), 10000);
      }

      setTimeout(() => message.delete().catch(() => {}), 1000);
      return;
    }

    // Delete any other message in check channel
    dbg('messageCreate -> deleting non-command message in check channel from', message.author.tag);
    setTimeout(() => message.delete().catch(() => {}), 1000);
    return;
  }
});

const app = express();
app.use(express.json());

app.post('/api/payment', async (req, res) => {
  dbg('/api/payment -> request headers:', req.headers);
  dbg('/api/payment -> request body:', req.body);

  const secret = req.header('x-shared-secret');
  if (secret !== SHARED_SECRET) {
    dbg('/api/payment -> unauthorized: bad shared secret');
    return res.status(401).send('Unauthorized');
  }

  const payload = req.body;
  if (!payload.userId || !payload.productId || !payload.receiptId) {
    dbg('/api/payment -> invalid payload:', payload);
    return res.status(400).send('Invalid payload');
  }

  if (db.deliveredReceipts[payload.receiptId]) {
    dbg('/api/payment -> already delivered receipt:', payload.receiptId);
    return res.status(200).send('Already delivered');
  }

  const discordId = payload.discordId || db.mappings[String(payload.userId)];
  dbg('/api/payment -> resolved discordId:', discordId, 'from payload or mappings');

  if (!discordId) {
    db.deliveredReceipts[payload.receiptId] = { status: 'pending', payload };
    await saveDB();
    dbg('/api/payment -> no discord id found, saved pending receipt:', payload.receiptId);
    return res.status(200).send('No Discord ID found');
  }

  const result = await deliverToDiscord(discordId, payload);
  db.deliveredReceipts[payload.receiptId] = {
    status: result.ok ? 'delivered' : 'failed',
    payload,
    deliveredAt: new Date().toISOString()
  };
  await saveDB();

  dbg('/api/payment -> delivery result for receipt', payload.receiptId, ':', result);
  res.status(200).send(result.ok ? 'Delivered' : 'Delivery failed');
});

app.post('/map', async (req, res) => {
  const secret = req.header('x-shared-secret');
  if (secret !== SHARED_SECRET) return res.status(401).send('Unauthorized');

  const { robloxId, discordId } = req.body;
  if (!robloxId || !discordId) return res.status(400).send('Missing fields');

  db.mappings[String(robloxId)] = discordId;
  await saveDB(); // note: await inside non-async express handler; we'll wrap
  dbg('/map -> mapping saved:', robloxId, '=>', discordId);
  res.send({ ok: true });
});

app.get('/health', (req, res) => {
  res.send({ status: 'ok', bot: client.user?.tag });
});

// Start up: load DB then login and start server
(async () => {
  await loadDB();
  client.login(DISCORD_TOKEN);
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    dbg('Express server started on port', PORT);
  });
})();

// Note: small fix - Express route 'app.post("/map")' used await in a non-async handler.
// We'll patch that by wrapping the handler above properly after file is loaded.
// To be safe, here's a corrected /map route replacement that supports await:

// Replace the previous /map with this:
app._router.stack = app._router.stack.filter(layer => !(layer.route && layer.route.path === '/map' && layer.route.methods.post));
app.post('/map', async (req, res) => {
  const secret = req.header('x-shared-secret');
  if (secret !== SHARED_SECRET) return res.status(401).send('Unauthorized');

  const { robloxId, discordId } = req.body;
  if (!robloxId || !discordId) return res.status(400).send('Missing fields');

  db.mappings[String(robloxId)] = discordId;
  await saveDB();
  dbg('/map -> mapping saved:', robloxId, '=>', discordId);
  res.send({ ok: true });
});
