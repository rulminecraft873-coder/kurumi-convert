const pluginConfig = {
    name: 'claim',
    alias: ['claim'],
    category: 'convert',
    description: 'Ambil video hasil convert dari web Kurumi ConvertSW pakai kode',
    usage: '.claim <kode>',
    example: '.claim A1B2C3D4',
    isOwner: false,
    isPremium: false,
    isGroup: false,
    isPrivate: false,
    cooldown: 5,
    energi: 1,
    isEnabled: true
}

const API_BASE_URL = process.env.CONVERTSW_API_URL || 'https://kurumi-convert-production.up.railway.app'

async function handler(m, { sock, args }) {
    const code = (args[0] || '').trim().toUpperCase()

    if (!code) {
        return m.reply(`Masukin kode klaim nya.\n\nContoh: *${m.prefix}claim A1B2C3D4*\n\nKode didapat setelah convert video di web.`)
    }

    m.react('⏳')

    try {
        const infoRes = await fetch(`${API_BASE_URL}/api/claim/${code}`)
        const info = await infoRes.json()

        if (!infoRes.ok) {
            m.react('❌')
            return m.reply(info.error || 'Kode tidak valid.')
        }

        await sock.sendMessage(
            m.chat,
            {
                video: { url: info.downloadUrl },
                mimetype: 'video/mp4',
                fileName: `status_${code}.mp4`,
                caption:
                    `*CLAIM SUCCESS - KURUMI CONVERTSW*\n\n` +
                    `• Input Size  : ${info.inputSize}\n` +
                    `• Output Size : ${info.outputSize}\n` +
                    `• Durasi Video: ${info.duration > 0 ? `${info.duration} Detik` : '60 Detik'}\n\n` +
                    `Video siap dikirim ke status WhatsApp.`,
                gifPlayback: false,
                ptv: false
            },
            { quoted: m }
        )

        // tandai claimed + hapus file di server setelah berhasil terkirim
        await fetch(`${API_BASE_URL}/api/claim/${code}/complete`, { method: 'POST' })

        m.react('✅')
    } catch (error) {
        console.error('[claim]', error.message)
        m.react('❌')
        await m.reply(`Gagal mengambil/mengirim video: ${error.message?.slice(0, 150)}`)
    }
}

export { pluginConfig as config, handler }
