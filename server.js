import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ====== CONFIG ======
const PORT = process.env.PORT || 3000
const STORAGE_DIR = process.env.CLAIM_STORAGE_DIR || path.join(__dirname, 'claims-storage')
const DB_PATH = path.join(STORAGE_DIR, 'claims.json')
const TMP_DIR = path.join(STORAGE_DIR, 'tmp')
const CODE_TTL_MS = 30 * 60 * 1000
const MAX_UPLOAD_MB = 250
const COBALT_API_URL = process.env.COBALT_API_URL || 'https://cobalt-production-66d6.up.railway.app'
const MAX_STORAGE_MB = 800

for (const dir of [STORAGE_DIR, TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '{}')

// ====== DB HELPER ======
function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) } catch { return {} }
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2))
}

function genCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase()
}

const STATS_PATH = path.join(STORAGE_DIR, 'stats.json')
if (!fs.existsSync(STATS_PATH)) {
  fs.writeFileSync(STATS_PATH, JSON.stringify({ totalConversions: 0, totalClaimed: 0 }))
}
function readStats() {
  try { return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) } catch { return { totalConversions: 0, totalClaimed: 0 } }
}
function writeStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2))
}
function bumpStat(key) {
  const stats = readStats()
  stats[key] = (stats[key] || 0) + 1
  writeStats(stats)
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function getDirSizeBytes(dir) {
  let total = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f)
      const st = fs.statSync(fp)
      if (st.isFile()) total += st.size
    }
  } catch {}
  return total
}

// Auto-cleanup: bersihin tmp sisa proses gagal + jaga kapasitas storage
function autoCleanupStorage() {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(TMP_DIR)) {
      const fp = path.join(TMP_DIR, f)
      const st = fs.statSync(fp)
      if (now - st.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp)
    }
  } catch {}

  const sizeBytes = getDirSizeBytes(STORAGE_DIR)
  const limitBytes = MAX_STORAGE_MB * 1024 * 1024
  if (sizeBytes <= limitBytes) return

  const db = readDb()
  const files = fs.readdirSync(STORAGE_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(STORAGE_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)

  let currentSize = sizeBytes
  for (const f of files) {
    if (currentSize <= limitBytes) break
    const fp = path.join(STORAGE_DIR, f.name)
    try {
      const sz = fs.statSync(fp).size
      fs.unlinkSync(fp)
      currentSize -= sz
      for (const code of Object.keys(db)) {
        if (db[code].file === f.name) delete db[code]
      }
      console.warn(`[cleanup] Hapus ${f.name} karena storage penuh`)
    } catch {}
  }
  writeDb(db)
}

// ====== FFMPEG ======
async function getVideoDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ])
    const d = Math.round(parseFloat(stdout.trim()))
    return isNaN(d) ? 0 : d
  } catch {
    return 0
  }
}

// Mode status: 1080p, 60fps, kualitas maksimal buat status WA (max 60 detik)
async function reencodeStatus(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-t', '60',
    '-threads', '2',
    '-vf', "scale='min(1080,iw)':-2",
    '-r', '60',
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'veryfast',
    '-sn',
    '-profile:v', 'high',
    '-level', '4.2',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    '-y', outputPath
  ], { timeout: 240000, maxBuffer: 1024 * 1024 * 10 })
}

// Mode compress: 1080p tapi bitrate lebih rendah biar ukuran lebih kecil, tanpa potong durasi
async function reencodeCompress(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-threads', '2',
    '-vf', "scale='min(1080,iw)':-2",
    '-c:v', 'libx264',
    '-crf', '28',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    '-y', outputPath
  ], { timeout: 300000, maxBuffer: 1024 * 1024 * 10 })
}

async function reencodeVideo(inputPath, outputPath, mode = 'status') {
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
  if (mode === 'compress') {
    await reencodeCompress(inputPath, outputPath)
  } else {
    await reencodeStatus(inputPath, outputPath)
  }
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
    throw new Error('Gagal merender video.')
  }
}

// Resolve link TikTok/IG/dll lewat instance cobalt
async function resolveWithCobalt(sourceUrl) {
  const res = await fetch(COBALT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ url: sourceUrl })
  })
  const data = await res.json()

  if (!res.ok || data.status === 'error') {
    throw new Error(data?.error?.code || data?.text || 'Gagal resolve link.')
  }

  const directUrl = data.url || data?.picker?.[0]?.url
  if (!directUrl) throw new Error('Link tidak bisa diproses (format tidak didukung).')

  return directUrl
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Gagal mengunduh video dari sumber.')
  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(destPath, buffer)
}

// ====== EXPRESS APP ======
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /video\/|mp4|mkv|mov/i.test(file.mimetype) || /\.(mp4|mkv|mov)$/i.test(file.originalname)
    cb(ok ? null : new Error('Format file harus video (mp4/mkv/mov).'), ok)
  }
})

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.post('/api/convert', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File video tidak ditemukan atau format tidak didukung.' })

  const mode = req.body.mode === 'compress' ? 'compress' : 'status'
  const inPath = req.file.path
  const ts = Date.now()
  const outPath = path.join(STORAGE_DIR, `sw_${ts}.mp4`)

  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 })

    const inStats = fs.statSync(inPath)
    const inputSize = formatSize(inStats.size)

    await reencodeVideo(inPath, outPath, mode)

    const duration = await getVideoDuration(outPath)
    const outStats = fs.statSync(outPath)
    const outputSize = formatSize(outStats.size)

    const code = genCode()
    const db = readDb()
    db[code] = {
      file: path.basename(outPath),
      createdAt: ts,
      expiresAt: ts + CODE_TTL_MS,
      claimed: false,
      inputSize,
      outputSize,
      duration,
      mode
    }
    writeDb(db)
    bumpStat('totalConversions')

    res.json({
      code,
      inputSize,
      outputSize,
      duration,
      mode,
      expiresInMinutes: CODE_TTL_MS / 60000
    })
  } catch (err) {
    console.error('[convert]', err)
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    res.status(500).json({ error: err.message?.slice(0, 200) || 'Konversi gagal.' })
  } finally {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath)
  }
})

app.post('/api/from-url', async (req, res) => {
  const sourceUrl = (req.body?.url || '').trim()
  const mode = req.body?.mode === 'compress' ? 'compress' : 'status'

  if (!sourceUrl) return res.status(400).json({ error: 'Link tidak boleh kosong.' })

  const ts = Date.now()
  const inPath = path.join(TMP_DIR, `dl_in_${ts}.mp4`)
  const outPath = path.join(STORAGE_DIR, `sw_${ts}.mp4`)

  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 })

    const directUrl = await resolveWithCobalt(sourceUrl)
    await downloadToFile(directUrl, inPath)

    if (!fs.existsSync(inPath) || fs.statSync(inPath).size < 1000) {
      throw new Error('Gagal mengunduh video dari link tersebut.')
    }

    const inStats = fs.statSync(inPath)
    const inputSize = formatSize(inStats.size)

    if (inStats.size > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new Error(`Ukuran video terlalu besar (maks ${MAX_UPLOAD_MB} MB).`)
    }

    await reencodeVideo(inPath, outPath, mode)

    const duration = await getVideoDuration(outPath)
    const outStats = fs.statSync(outPath)
    const outputSize = formatSize(outStats.size)

    const code = genCode()
    const db = readDb()
    db[code] = {
      file: path.basename(outPath),
      createdAt: ts,
      expiresAt: ts + CODE_TTL_MS,
      claimed: false,
      inputSize,
      outputSize,
      duration,
      mode
    }
    writeDb(db)
    bumpStat('totalConversions')

    res.json({
      code,
      inputSize,
      outputSize,
      duration,
      mode,
      expiresInMinutes: CODE_TTL_MS / 60000
    })
  } catch (err) {
    console.error('[from-url]', err)
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    res.status(500).json({ error: err.message?.slice(0, 200) || 'Gagal memproses link.' })
  } finally {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath)
  }
})

app.get('/api/claim/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase()
  const db = readDb()
  const rec = db[code]

  if (!rec) return res.status(404).json({ error: 'Kode tidak valid.' })
  if (rec.claimed) return res.status(410).json({ error: 'Kode sudah pernah diklaim.' })
  if (rec.expiresAt < Date.now()) {
    delete db[code]
    writeDb(db)
    return res.status(410).json({ error: 'Kode sudah expired.' })
  }

  res.json({
    valid: true,
    inputSize: rec.inputSize,
    outputSize: rec.outputSize,
    duration: rec.duration,
    mode: rec.mode || 'status',
    downloadUrl: `${req.protocol}://${req.get('host')}/api/file/${code}`
  })
})

app.get('/api/file/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase()
  const db = readDb()
  const rec = db[code]

  if (!rec || rec.claimed || rec.expiresAt < Date.now()) {
    return res.status(404).send('File tidak tersedia.')
  }

  const filePath = path.join(STORAGE_DIR, rec.file)
  if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan.')

  res.sendFile(filePath)
})

app.post('/api/claim/:code/complete', (req, res) => {
  const code = (req.params.code || '').toUpperCase()
  const db = readDb()
  const rec = db[code]

  if (!rec) return res.status(404).json({ error: 'Kode tidak ditemukan.' })

  rec.claimed = true
  db[code] = rec
  writeDb(db)
  bumpStat('totalClaimed')

  const filePath = path.join(STORAGE_DIR, rec.file)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

  res.json({ ok: true })
})

app.get('/api/stats', (req, res) => {
  res.json(readStats())
})

setInterval(() => {
  const db = readDb()
  const now = Date.now()
  let changed = false
  for (const code of Object.keys(db)) {
    const rec = db[code]
    if (rec.expiresAt < now) {
      const fp = path.join(STORAGE_DIR, rec.file)
      if (fs.existsSync(fp)) fs.unlinkSync(fp)
      delete db[code]
      changed = true
    }
  }
  if (changed) writeDb(db)
  autoCleanupStorage()
}, 5 * 60 * 1000)

autoCleanupStorage()

app.listen(PORT, () => console.log(`Kurumi ConvertSW jalan di port ${PORT}`))
