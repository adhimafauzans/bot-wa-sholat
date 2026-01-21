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
let cronStarted = false

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
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta"
  })
}

function toMinutes(time) {
  if (!time) return null
  const [h, m] = time.split(":").map(Number)
  return h * 60 + m
}

async function isAdmin(sock, jid, sender) {
  const meta = await sock.groupMetadata(jid)
  return meta.participants.some(
    p => p.id === sender && (p.admin === "admin" || p.admin === "superadmin")
  )
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  return `${h}:${m}`
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
  for (const gid of Object.keys(groupConfig)) {
    if (!groupConfig[gid]?.active) continue

    try {
      await sock.sendMessage(gid, { text })
    } catch (err) {
      logError(err, `SEND_GROUP_${gid}`)

      // OPTIONAL: auto-disable group yang error
      if (err?.message?.includes("not a participant")) {
        delete groupConfig[gid]
        saveConfig()
      }
    }
  }
}


// ===============================
// CHECK & REMINDER
// ===============================
async function checkSholat(sock) {
  try {
    if (!jadwalSholat || Object.keys(jadwalSholat).length === 0) return

    if (getTodayKey() !== todayKey) {
      await fetchJadwalSholat()
      return
    }

    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const nowStr = formatTime(now)

    const times = {
      imsak: "Imsak",
      subuh: "Subuh",
      dzuhur: "Dzuhur",
      ashar: "Ashar",
      maghrib: "Maghrib",
      isya: "Isya"
    }

    let isLoggedTarget = false

    for (const key in times) {
      const t = toMinutes(jadwalSholat[key])
      if (t === null) continue
      
      const targetStr = jadwalSholat[key]

      if (!isLoggedTarget && nowMin <= t) {
        console.log(
          `Next Target Shalat : ${times[key]} | now=${nowMin}(${nowStr}) | target=${t}(${targetStr}) | match=${nowMin === t}`
        )
        isLoggedTarget = true
      }
      
      // ⏰ 10 menit sebelum
      if (nowMin === t - 10) {
        await sendToGroups(
          sock,
          `⏰ *10 Menit Menuju ${times[key]}*\n🕓 ${jadwalSholat[key]} WIB\n✨ Persiapkan diri untuk sholat`
        )
      }

      // 🕌 tepat waktu
      if (nowMin === t) {
        await sendToGroups(
          sock,
          `🕌 *WAKTU SHOLAT*\n\n` +
          `Telah masuk waktu *${times[key]}*\n` +
          `🙏 Mari kita tunaikan sholat tepat waktu\n` +
          `Ke Masjid lebih baik ^_^`
        )

        await sendToGroups(
          sock,
          `🤲 *DOA SETELAH ADZAN*\n\n` +
          `اللَّهُمَّ رَبَّ هَذِهِ الدَّعْوَةِ التَّامَّةِ وَالصَّلَاةِ الْقَائِمَةِ آتِ مُحَمَّدًا الْوَسِيلَةَ وَالْفَضِيلَةَ وَابْعَثْهُ مَقَامًا مَحْمُودًا الَّذِي وَعَدْتَهُ اِنَكَ لاَ تُخْلِفُ اْلمِيْعَاد` +
          `\n\nAllahumma rabba haadzihid da'watit taammah,\n` +
          `Wash shalaatil qaa-imah,\n` +
          `Aati muhammadal wasiilata wal fadhiilah,\n` +
          `wab'atshu maqaman mahmudanilladzi wa'adtah,\n` +
          `innaka la tukhliful mi'ad`
        )
      }
    }
  } catch (err) {
    logError(err, "CRON")
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

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log("📲 SCAN QR CODE DI LOG INI:")
      console.log(qr)
    }

    if (connection === "open") {
      console.log("🤖 Bot connected")
      await fetchJadwalSholat()
      startCron(sock)
    }

    if (connection === "close") {
      if (
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut
      ) {
        console.log("🔄 Reconnecting...")
      }
    }
  })

  sock.ev.on("group-participants.update", async (update) => {
    try {
      const botJid = sock.user.id.replace(/:\d+/, "")

      const isBotParticipant = update.participants.some(p =>
        p.phoneNumber === botJid || p.id === sock.user.lid
      )

      // =========================
      // ➕ BOT DITAMBAHKAN KE GRUP
      // =========================
      if (update.action === "add" && isBotParticipant) {
        console.log(`➕ Bot ditambahkan ke grup ${update.id}`)

        // inisialisasi config grup
        if (!groupConfig[update.id]) {
          groupConfig[update.id] = {
            active: true,
            welcomed: false
          }
          saveConfig()
        }
      }

      // =========================
      // ❌ BOT DIKELUARKAN DARI GRUP
      // =========================
      if (update.action === "remove" && isBotParticipant) {
        console.log(`👋 Bot dikeluarkan dari grup ${update.id}`)

        if (groupConfig[update.id]) {
          delete groupConfig[update.id]
          saveConfig()
          console.log(`🗑️ Config grup ${update.id} dihapus`)
        }
      }

    } catch (err) {
      logError(err, "GROUP_PARTICIPANTS")
    }
  })


  // ===== MESSAGE =====
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
        groupConfig[from] = {
          active: true,
          welcomed: false
        }
        saveConfig()
      }

      if (!groupConfig[from].welcomed) {
        await sock.sendMessage(from, {
          text: `🤖 *BOT PENGINGAT SHOLAT AKTIF*
Assalamu’alaikum warahmatullahi wabarakatuh 👋

Saya adalah bot pengingat waktu sholat 🕌
Saya akan membantu mengingatkan:
⏰ 10 menit sebelum sholat
🕌 Tepat waktu sholat + doa setelah adzan

━━━━━━━━━━━━━━

📌 *PERINTAH BOT*
/bot info    → Lihat semua command
/bot jadwal  → Jadwal sholat hari ini
/bot on      → Aktifkan bot (admin)
/bot off     → Matikan bot (admin)
/bot update  → Update jadwal (admin)
/bot status  → Periksa status bot

━━━━━━━━━━━━━━

📍 *Lokasi*
Kota Jakarta (WIB)

🤲 Semoga bermanfaat dan menambah keberkahan`
        })

        groupConfig[from].welcomed = true
        saveConfig()
      }

      const admin = await isAdmin(sock, from, sender)

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
            `📌 *PERINTAH BOT*
/bot info   → Lihat semua command
/bot jadwal → Jadwal sholat hari ini
/bot on     → Aktifkan bot (admin)
/bot off    → Matikan bot (admin)
/bot update  → Update jadwal (admin)
/bot status   → Periksa status bot

━━━━━━━━━━━━━━

📍 *Lokasi*
Kota Jakarta (WIB)`
        })
      }

      if (text === "/bot update" && admin) {
        await fetchJadwalSholat()
        return sock.sendMessage(from, { text: "🔄 Jadwal diperbarui" })
      }

      if (text === "/bot today" || text === "/bot jadwal") {
        return sock.sendMessage(from, {
          text:
            `🕌 *Jadwal Sholat Hari Ini*
            Imsak   : ${jadwalSholat.imsak}
            Subuh  : ${jadwalSholat.subuh}
            Dzuhur : ${jadwalSholat.dzuhur}
            Ashar  : ${jadwalSholat.ashar}
            Maghrib: ${jadwalSholat.maghrib}
            Isya   : ${jadwalSholat.isya}`
        })
      }

      if (text === "/bot status") {
        return sock.sendMessage(from, {
          text: `📊 *STATUS BOT*\n\n` +
                `Status: ${groupConfig[from].active ? "🟢 ON" : "🔴 OFF"}`
        })
      }
    } catch (err) {
      logError(err, "MESSAGE")
    }
  })

  function startCron(sock) {
    if (cronStarted) {
      console.log("⛔ Cron sudah berjalan, skip")
      return
    }

    cronStarted = true
    console.log("⏱️ Cron dimulai")

    cron.schedule("0 2 * * *", fetchJadwalSholat, {
      timezone: "Asia/Jakarta"
    })

    cron.schedule("* * * * *", () => {
      checkSholat(sock)
    }, {
      timezone: "Asia/Jakarta"
    })
  }

}

startBot()