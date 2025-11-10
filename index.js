import 'dotenv/config';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev_secret';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error("Set DISCORD_TOKEN in .env");
  process.exit(1);
}

// Base de datos simple (para guardar relaciones y entregas)
const DB_PATH = path.join(process.cwd(), 'storage', 'db.json');
fs.ensureFileSync(DB_PATH);
let db = { mappings: {}, deliveredReceipts: {} };
try { db = fs.readJsonSync(DB_PATH); } catch(e){ fs.writeJsonSync(DB_PATH, db); }

function saveDB() {
  fs.writeJsonSync(DB_PATH, db, { spaces: 2 });
}

// Inicializa el bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
});

// Asocia producto con archivo
const productMap = {
  "12345678": { filename: "configs/configPremium.zip", description: "Premium config" }
};

// Función para enviar mensaje y archivo
async function deliverToDiscord(discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    if (!user) return { ok: false, error: 'Usuario no encontrado' };

    const product = productMap[payload.productId];
    const message = `🎉 **Compra recibida**  
Usuario: ${payload.username}  
Producto: ${payload.productId}  
Recibo: ${payload.receiptId}`;

    await user.send(message);

    if (product && fs.existsSync(product.filename)) {
      await user.send({ files: [product.filename] });
    } else {
      await user.send("⚠️ Archivo no configurado. Contacta con soporte.");
    }

    return { ok: true };
  } catch (err) {
    console.error("Error enviando DM:", err);
    return { ok: false, error: err.message };
  }
}

// Express server
const app = express();
app.use(express.json());

// Endpoint principal de pago
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
    console.log("No Discord ID for user", payload.userId);
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

// Endpoint para añadir mappings manualmente
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
app.listen(PORT, () => console.log(`🌐 Servidor escuchando en puerto ${PORT}`));
