// lib/backup.mjs —— 备份的唯一实现是 scripts/backup-memory.ps1，这里只负责调它
//
// 为什么改成「调脚本」而不是各写一份：
// 原来这里和 D:\Ayu\qq-bridge\scripts\backup-memory.ps1 是两份逻辑相同的实现。
// 2026-11-05 扩备份范围时两边都得改，漏一边就会出现「桥接备份是全的、定时器备份是残的」
// 这种最难查的状态。现在 PS1 是唯一实现（含 sqlite 一致性快照、哈希、保留策略），
// 这里只解析它输出的那行 JSON。
//
// 顺手修掉的 bug：
// 旧版 oncePerDay 用 new Date().toISOString()（UTC）判断「今天备份过没」。
// 本地 00:00–08:00 这段 UTC 还停在昨天，会被判成「昨天已备份」而整天不备份，
// 于是凌晨这段的备份完全靠桥接重启来触发。现在这个判断在 PS1 里用本地日期做。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SCRIPT = 'D:\\Ayu\\qq-bridge\\scripts\\backup-memory.ps1'
const TIMEOUT_MS = 20 * 60 * 1000

function driveOf(p) {
  const m = /^([A-Za-z]:)/.exec(String(p || ''))
  return m ? m[1] + '\\' : null
}

function runPs(args) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    let child
    try {
      child = spawn('powershell.exe', args, { windowsHide: true })
    } catch (e) {
      return resolve({ code: -1, out, err: String(e) })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      if (!done) { done = true; resolve({ code: -1, out, err: 'timeout' }) }
    }, TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e) })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

/** 从输出里抠最后一行 JSON（PS 前面可能还有别的东西） */
function lastJson(text) {
  const lines = String(text || '').trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim()
    if (!s.startsWith('{')) continue
    try { return JSON.parse(s) } catch {}
  }
  return null
}

export async function runBackup(cfg, store) {
  const b = cfg.backup || {}
  const target = b.target || 'F:\\大肥鱼的记忆备份'
  const drive = driveOf(target)
  if (!drive || !fs.existsSync(drive)) {
    return { skipped: true, reason: `目标盘 ${drive ?? '?'} 不在` }
  }

  const keep = Number(b.keep) || 45
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Target', target,
    '-Keep', String(keep),
    '-Quiet', '-Json',
  ]
  if (b.oncePerDay) args.push('-OncePerDay')

  const r = await runPs(args)
  const j = lastJson(r.out)

  if (!j) {
    // 脚本没输出可解析的结果（被截断、PowerShell 挂了）→ 不谎报成功
    return {
      skipped: false,
      dest: '',
      folders: [],
      files: 0,
      error: (r.err || r.out || 'no-json').slice(0, 300),
    }
  }

  if (j.skipped === true) {
    return { skipped: true, reason: j.reason || 'skipped' }
  }
  if (j.error === 'already-done-today') {
    return { skipped: true, reason: '今天已经备份过' }
  }
  if (!j.ok) {
    return {
      skipped: false,
      dest: j.dest || '',
      folders: [],
      files: Number(j.files) || 0,
      error: j.error || 'unknown',
    }
  }

  return {
    skipped: false,
    dest: j.dest,
    folders: (j.items || []).map((x) => x.name),
    files: Number(j.files) || 0,
    mb: Number(j.mb) || 0,
    stats: store?.stats?.(),
  }
}
