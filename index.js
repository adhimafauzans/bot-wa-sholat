import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys"

import cron from "node-cron"
import axios from "axios"
import fs from "fs"

// ===============================
// CONFIG
// ===============================
const API_URL =
  "https://api.myquran.com/v3/sholat/jadwal/58a2fc6ed39fd083f55d4182bf88826d/today?tz=Asia%2FJakarta"

const CONFIG_FILE = "./group-config.json"

// ===============================
// STATE
// ===============================
let jadwalSholat = {}
let todayKey = ""
let groupConfig = {}

// ===============================
// LOAD / SAVE CONFIG
// ===============================
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2))
    console.log("📁 group-config.json dibuat otomatis")
  }
  groupConfig = JSON.parse(fs.readFileSync(CONFIG_FILE))
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(groupConfig, null, 2))
}

// ===============================
// UTIL
// ===============================
function logError(err, tag = "ERROR") {
  console.error(`❌ [${tag}]`, err?.message || err)
}

function getTodayKey() {
  return new Date().toISOString().split("T")[0]
}

function toMinutes(time) {
  const [h, m] = time.split(":").map(Number)
  return h * 60 + m
}

async function isAdmin(sock, jid, sender) {
  const meta = await sock.groupMetadata(jid)
  return meta.participants.some(
    p => p.id === sender && (p.admin === "admin" || p.admin === "superadmin")
  )
}

// ===============================
// FETCH JADWAL SHOLAT
// ===============================
async function fetchJadwalSholat() {
  try {
    const res = await axios.get(API_URL)
    const key = Object.keys(res.data.data.jadwal)[0]

    jadwalSholat = res.data.data.jadwal[key]
    todayKey = key

    console.log("🕌 Jadwal sholat loaded:", jadwalSholat)
  } catch (err) {
    logError(err, "FETCH_SHOLAT")
  }
}

// ===============================
// SEND TO ALL ACTIVE GROUPS
// ===============================
async function sendToGroups(sock, text) {
  for (const gid in groupConfig) {
    if (groupConfig[gid].active) {
      await sock.sendMessage(gid, { text })
    }
  }
}

// ===============================
// CHECK & REMINDER
// ===============================
async function checkSholat(sock) {
  if (!jadwalSholat || getTodayKey() !== todayKey) return

  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const times = {
    imsak: "Imsak",
    subuh: "Subuh",
    dzuhur: "Dzuhur",
    ashar: "Ashar",
    maghrib: "Maghrib",
    isya: "Isya"
  }

  for (const key in times) {
    const t = toMinutes(jadwalSholat[key])

    // ⏰ 10 menit sebelum
    if (nowMin === t - 10) {
      await sendToGroups(
        sock,
        `⏰ *10 Menit Menuju ${times[key]}*\n🕰️ ${jadwalSholat[key]}\n✨ Persiapkan diri untuk sholat`
      )
    }

    // 🕌 tepat waktu
    if (nowMin === t) {
      await sendToGroups(
        sock,
        `🕌 *WAKTU SHOLAT*\n\n` +
        `Telah masuk waktu *${name}*\n` +
        `🙏 Mari kita tunaikan sholat tepat waktu` +
        `Ke Masjid lebih baik ^_^`
      )

      await sendToGroups(
        sock,
        `🤲 *DOA SETELAH ADZAN*\n\n` +
        `اللَّهُمَّ رَبَّ هَذِهِ الدَّعْوَةِ التَّامَّةِ وَالصَّلَاةِ الْقَائِمَةِ آتِ مُحَمَّدًا الْوَسِيلَةَ وَالْفَضِيلَةَ وَابْعَثْهُ مَقَامًا مَحْمُودًا الَّذِي وَعَدْتَهُ اِنَكَ لاَ تُخْلِفُ اْلمِيْعَاد` +
        `\n\n Allahumma rabba haadzihid da'watit taammah,\n` +
        `Wash shalaatil qaa-imah,\n` +
        `Aati muhammadal wasiilata wal fadhiilah,\n` +
        `wab'atshu maqaman mahmudanilladzi wa'adtah,\n` +
        `innaka la tukhliful mi'ad`
      )
    }
  }
}

// ===============================
// MAIN
// ===============================
async function startBot() {
  loadConfig()

  const { state, saveCreds } = await useMultiFileAuthState("./auth")
  const sock = makeWASocket({ auth: state })

  sock.ev.on("creds.update", saveCreds)

  // ===== CONNECTION =====
  sock.ev.on("connection.update", async update => {
    if (update.connection === "open") {
      console.log("🤖 Bot connected")
      await fetchJadwalSholat()
    }

    if (update.connection === "close") {
      if (
        update.lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut
      ) {
        startBot()
      }
    }
  })

  // ===== BOT DITAMBAHKAN KE GRUP =====
  sock.ev.on("group-participants.update", async update => {
    try {
      const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net"

      if (
        update.action === "add" &&
        update.participants.includes(botId)
      ) {
        groupConfig[update.id] = { active: true }
        saveConfig()

        await sock.sendMessage(update.id, {
          text:
`🤖 *BOT SHOLAT AKTIF*
Assalamu’alaikum 👋

Saya siap mengingatkan waktu sholat 🕌

📌 *Perintah Utama*
/bot info → Lihat semua command
/bot jadwal → Jadwal sholat hari ini
/bot off → Matikan bot (admin)

Semoga bermanfaat 🤲`
        })
      }
    } catch (err) {
      logError(err, "GROUP_JOIN")
    }
  })

  // ===== MESSAGE HANDLER =====
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg.message || msg.key.fromMe) return

      const from = msg.key.remoteJid
      if (!from.endsWith("@g.us")) return

      const sender = msg.key.participant
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ""

      if (!groupConfig[from]) {
        groupConfig[from] = { active: true }
        saveConfig()
      }

      const admin = await isAdmin(sock, from, sender)

      // ===== COMMAND =====
      if (text === "/bot on" && admin) {
        groupConfig[from].active = true
        saveConfig()
        return sock.sendMessage(from, { text: "✅ Bot diaktifkan" })
      }

      if (text === "/bot off" && admin) {
        groupConfig[from].active = false
        saveConfig()
        return sock.sendMessage(from, { text: "⛔ Bot dimatikan" })
      }

      if (text === "/bot info") {
        return sock.sendMessage(from, {
          text:
            `🤖 *BOT SHOLAT*
            /bot on → Aktifkan bot
            /bot off → Matikan bot
            /bot jadwal → Jadwal sholat hari ini
            /bot fetch → Update jadwal (admin)`
        })
      }

      if (text === "/bot fetch" && admin) {
        await fetchJadwalSholat()
        return sock.sendMessage(from, { text: "🔄 Jadwal sholat diperbarui" })
      }

      if (text === "/bot jadwal") {
        return sock.sendMessage(from, {
          text:
            `🕌 *Jadwal Sholat Hari Ini*
            🕓 Imsak   : ${jadwalSholat.imsak}
            🌅 Subuh  : ${jadwalSholat.subuh}
            ☀️ Dzuhur : ${jadwalSholat.dzuhur}
            🌇 Ashar  : ${jadwalSholat.ashar}
            🌆 Maghrib: ${jadwalSholat.maghrib}
            🌙 Isya   : ${jadwalSholat.isya}`
        })
      }
    } catch (err) {
      logError(err, "MESSAGE")
    }
  })

  // ===== CRON =====
  cron.schedule("0 2 * * *", fetchJadwalSholat) // 02:00 WIB
  cron.schedule("* * * * *", () => checkSholat(sock)) // tiap menit
}

startBot()
