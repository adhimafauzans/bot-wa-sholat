const {
  default: makeWASocket,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys")

const Pino = require("pino")
const qrcode = require("qrcode-terminal")
const cron = require("node-cron")
const axios = require("axios")

// ================= CONFIG =================
const API_URL =
  "https://api.myquran.com/v3/sholat/jadwal/58a2fc6ed39fd083f55d4182bf88826d/today?tz=Asia%2FJakarta"

const RAMADHAN_START = new Date("2026-02-18")
const RAMADHAN_END = new Date("2026-03-20")
// ==========================================

let jadwal = {}
let groups = {} // { groupId: { enabled: true } }

// ================= UTIL =================
const isRamadhan = () => {
  const now = new Date()
  return now >= RAMADHAN_START && now <= RAMADHAN_END
}

const isAdmin = (groupMeta, jid) => {
  return groupMeta.participants.some(
    p =>
      p.id === jid &&
      (p.admin === "admin" || p.admin === "superadmin")
  )
}

// ================= FETCH JADWAL =================
async function fetchJadwal() {
  try {
    const res = await axios.get(API_URL)
    const today = new Date().toISOString().split("T")[0]
    jadwal = res.data?.data?.jadwal?.[today] || {}
    console.log("🕌 Jadwal sholat diperbarui")
  } catch (e) {
    console.error("❌ Fetch jadwal gagal:", e.message)
  }
}

// ================= BOT =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")

  const sock = makeWASocket({
    auth: state,
    logger: Pino({ level: "silent" })
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", ({ qr, connection }) => {
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === "open") console.log("✅ BOT AKTIF")
  })

  await fetchJadwal()
  cron.schedule("0 2 * * *", fetchJadwal)

  // ================= SEND =================
  const sendToGroups = async (text) => {
    for (const [gid, cfg] of Object.entries(groups)) {
      if (!cfg.enabled) continue
      await sock.sendMessage(gid, { text })
    }
  }

  // ================= SHOLAT =================
  const sholatNow = async (name) => {
    await sendToGroups(
      `🕌 *WAKTU SHOLAT*\n\n` +
      `Telah masuk waktu *${name}*\n` +
      `🙏 Mari kita tunaikan sholat tepat waktu` +
      `Ke Masjid lebih baik ^_^`
    )

    await sendToGroups(
      `🤲 *DOA SETELAH ADZAN*\n\n` +
      `اللَّهُمَّ رَبَّ هَذِهِ الدَّعْوَةِ التَّامَّةِ وَالصَّلَاةِ الْقَائِمَةِ آتِ مُحَمَّدًا الْوَسِيلَةَ وَالْفَضِيلَةَ وَابْعَثْهُ مَقَامًا مَحْمُودًا الَّذِي وَعَدْتَهُ اِنَكَ لاَ تُخْلِفُ اْلمِيْعَاد` +
      `Allahumma rabba haadzihid da'watit taammah,\n` +
      `Wash shalaatil qaa-imah,\n` +
      `Aati muhammadal wasiilata wal fadhiilah,\n` +
      `wab'atshu maqaman mahmudanilladzi wa'adtah,\n` +
      `innaka la tukhliful mi'ad`
    )
  }

  const reminder = (label, text) =>
    sendToGroups(`⏰ *${label}*\n\n${text}`)

  const schedule = (time, fn) => {
    const [h, m] = time.split(":")
    cron.schedule(`${m} ${h} * * *`, fn)
  }

  const reminder10Min = (time, fn) => {
    const [h, m] = time.split(":").map(Number)
    const d = new Date()
    d.setHours(h, m - 10)
    cron.schedule(`${d.getMinutes()} ${d.getHours()} * * *`, fn)
  }

  // ================= REGISTER CRON =================
  const sholatTimes = {
    Subuh: jadwal.subuh,
    Dzuhur: jadwal.dzuhur,
    Ashar: jadwal.ashar,
    Maghrib: jadwal.maghrib,
    Isya: jadwal.isya
  }

  for (const [name, time] of Object.entries(sholatTimes)) {
    if (!time) continue
    reminder10Min(time, () =>
      reminder(
        "PENGINGAT SHOLAT",
        `10 menit lagi masuk waktu *${name}*\n📿 Bersiaplah`
      )
    )
    schedule(time, () => sholatNow(name))
  }

  // ===== RAMADHAN =====
  if (isRamadhan()) {
    reminder10Min(jadwal.imsak, () =>
      reminder(
        "PENGINGAT IMSAK",
        "10 menit lagi imsak\n🍽️ Segera akhiri sahur"
      )
    )

    schedule(jadwal.imsak, () =>
      sendToGroups("🌙 *IMSAK*\n🛑 Waktu imsak telah tiba")
    )

    schedule(jadwal.maghrib, () =>
      sendToGroups("🍽️ *WAKTU BERBUKA*\n🤲 Allahumma laka shumtu")
    )
  }

  // ================= COMMAND =================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    if (!from.endsWith("@g.us")) return

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text

    // register group
    if (!groups[from]) {
      groups[from] = { enabled: true }
      await sock.sendMessage(from, {
        text: "🤖 Bot sholat aktif di grup ini\nGunakan: /bot on / off"
      })
    }

    const meta = await sock.groupMetadata(from)
    const sender = msg.key.participant

    if (!isAdmin(meta, sender)) return

    if (text === "/bot on") {
      groups[from].enabled = true
      await sock.sendMessage(from, { text: "🟢 Bot DIHIDUPKAN" })
    }

    if (text === "/bot off") {
      groups[from].enabled = false
      await sock.sendMessage(from, { text: "🔴 Bot DIMATIKAN" })
    }

    if (text === "/bot status") {
      await sock.sendMessage(from, {
        text:
          `📊 *STATUS BOT*\n\n` +
          `Status: ${groups[from].enabled ? "🟢 ON" : "🔴 OFF"}`
      })
    }
  })
}

startBot()
