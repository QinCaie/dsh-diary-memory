// lib/store.mjs —— 记忆存储层（单文件 jsonl + 无损合并）
//
// 与 DSH 无关的纯逻辑：只依赖 fs/path，插件和 CLI 都能用。
// 所有路径与上限都来自传入的 config，不再写死。
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_CATEGORIES = ['老大', '约定', '正在进行', '我们的梗', '其他']

export function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function makeStore(cfg) {
  const root = cfg.dataDir
  const main = path.join(root, cfg.files?.main || '大肥鱼的日记.jsonl')
  const inbox = path.join(root, cfg.files?.inbox || '传入')
  const archive = path.join(root, cfg.files?.archive || '已合并')
  const categories = Array.isArray(cfg.longTerm?.categories) && cfg.longTerm.categories.length
    ? cfg.longTerm.categories
    : DEFAULT_CATEGORIES

  const limits = {
    diaryPerDay: num(cfg.diary?.perDay, 10),
    diarySoft: num(cfg.diary?.softLimit, 200),
    diaryHard: num(cfg.diary?.hardLimit, 300),
    todayMax: num(cfg.today?.maxLength, 500),
    factMax: num(cfg.longTerm?.factMax, 50),
    totalMax: num(cfg.longTerm?.totalMax, 1500),
  }

  function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

  function ensureLayout() {
    for (const dir of [root, inbox, archive]) {
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    }
    if (!fs.existsSync(main)) {
      try { fs.writeFileSync(main, '', 'utf8') } catch {}
    }
  }

  function readJsonl(file) {
    const out = []
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { return out }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const rec = JSON.parse(t)
        if (rec && typeof rec === 'object' && ['日记', '今天', '长期记忆', '归档'].includes(rec['类型'])) out.push(rec)
      } catch {}
    }
    return out
  }

  function readAll() { return readJsonl(main) }

  function keyOf(rec) {
    const type = String(rec['类型'] || '')
    if (type === '长期记忆') return `长期记忆|${rec['分类'] || ''}`
    if (type === '归档') return `归档|${rec['分类'] || ''}|${rec['归档时间'] || ''}`
    return `${type}|${rec['时间'] || ''}|${String(rec['内容'] || '').replace(/\s+/g, ' ').trim()}`
  }

  function sortKey(rec) {
    return String(rec['更新时间'] || rec['归档时间'] || rec['时间'] || '')
  }

  // ── 记忆清晰度与使用热度 ────────────────────────────────────
  // 为什么要它（2026-11-07）：日记里所有条目以前一样清楚，写旧事时我容易照实说，
  // 其实早就只记得个大概。借 HCEM 的"记忆模糊度"思路，**只借这一条**，不借情绪打分。
  // 做法：jsonl 一个字不动，另存一个 sidecar（哪条被翻过、翻过几次），
  // 清晰度 = 距今年数衰减 + 被翻次数加成；标了「重要」的衰减慢 4 倍、有下限。
  const usageFile = path.join(root, '记忆使用.json')
  const USAGE_MAX = 3000
  const HALF_LIFE_DAYS = 120
  let usage = null

  function loadUsage() {
    if (usage) return usage
    try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')) || {} } catch { usage = {} }
    return usage
  }
  function saveUsage() {
    const u = loadUsage()
    const keys = Object.keys(u)
    if (keys.length > USAGE_MAX) {
      keys.sort((a, b) => String(u[a]?.last || '').localeCompare(String(u[b]?.last || '')))
      for (const k of keys.slice(0, keys.length - USAGE_MAX)) delete u[k]
    }
    try { fs.writeFileSync(usageFile, JSON.stringify(u), 'utf8') } catch {}
  }
  function touchUsage(keys) {
    if (!keys || !keys.length) return
    const u = loadUsage()
    const now = stamp()
    for (const k of keys) {
      const e = u[k] || { hits: 0, last: '' }
      e.hits = (Number(e.hits) || 0) + 1
      e.last = now
      u[k] = e
    }
    saveUsage()
  }
  function dayDiff(ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(ts || ''))
    if (!m) return 999
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
    return Math.max(0, (Date.now() - t.getTime()) / 86400000)
  }
  const clamp01 = (n) => Math.min(1, Math.max(0, n))

  // rec 需要至少带 时间/更新时间 与 内容 才能算：时间决定衰减，条目决定 id。
  // 注意：翻开过 ≠ 记成新的。衰减只看写入时间，回忆只给"加成"，
  // 否则一条被翻过一次的旧事会永远显示成很清楚（2026-11-07 测出来的坑）。
  function clarityOf(rec, usageKey) {
    const k = usageKey || keyOf(rec)
    const u = loadUsage()[k]
    const written = String(rec['时间'] || rec['更新时间'] || rec['归档时间'] || '')
    const ageDays = dayDiff(written)
    const held = rec['重要'] === true ? HALF_LIFE_DAYS * 4 : HALF_LIFE_DAYS
    const base = 0.95 * Math.exp(-ageDays / held)
    const sinceSeen = u?.last ? dayDiff(u.last) : Infinity
    const recallBonus = sinceSeen < 7 ? 0.18 : sinceSeen < 30 ? 0.10 : sinceSeen < 90 ? 0.05 : 0
    const hitBonus = Math.min(0.2, (Number(u?.hits) || 0) * 0.025)
    const c = clamp01(base + recallBonus + hitBonus)
    return rec['重要'] === true ? Math.max(c, 0.85) : c
  }
  const tierOf = (c) => (c >= 0.7 ? '清楚' : c >= 0.45 ? '大概' : c >= 0.25 ? '模糊' : '淡了')
  const round2 = (n) => Math.round(n * 100) / 100

  // ── 近似重复判断 ────────────────────────────────────────────
  // 为什么需要：keyOf 是"时间+内容"全等才算重复，但她两次描述同一件事
  // 往往只差几个字（"他没答" / "他没正面答"），于是存成了两条。
  // 用字符二元组的 Dice 系数来判相似度，同类时间点里相似度高的只留一条。
  function normalizeText(s) {
    return String(s || '')
      .replace(/[\s，。、！？；：""''（）()\[\]【】…—\-·,.!?;:'"]/g, '')
      .toLowerCase()
  }

  function bigrams(s) {
    const n = normalizeText(s)
    const set = new Set()
    for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2))
    if (n.length === 1) set.add(n)
    return set
  }

  function dice(a, b) {
    const A = bigrams(a)
    const B = bigrams(b)
    if (A.size === 0 || B.size === 0) return 0
    let hit = 0
    for (const g of A) if (B.has(g)) hit++
    return (2 * hit) / (A.size + B.size)
  }

  const NEAR_DUP = 0.75   // 相似度阈值：同一事件两句话通常 > 0.85，不同事件一般 < 0.5

  // 把「日记/今天」里同一时间点、内容高度相似的记录去掉，保留更长的那条
  // （更长的通常信息更全）。返回去重后的数组。
  function dedupeRecords(records) {
    const out = []
    const byTime = new Map()   // 时间 -> 已保留的记录索引数组
    for (const rec of records) {
      const type = String(rec['类型'] || '')
      if (type !== '日记' && type !== '今天') { out.push(rec); continue }
      const t = String(rec['时间'] || '')
      const idxs = byTime.get(t) || []
      let dupOf = -1
      for (const i of idxs) {
        if (dice(rec['内容'], out[i]['内容']) >= NEAR_DUP) { dupOf = i; break }
      }
      if (dupOf < 0) {
        idxs.push(out.length)
        byTime.set(t, idxs)
        out.push(rec)
      } else if (String(rec['内容'] || '').length > String(out[dupOf]['内容'] || '').length) {
        out[dupOf] = rec   // 新来的更完整，替换掉旧的
      }
    }
    return out
  }

  function combine(records) {
    const plain = new Map()
    const longTerm = new Map()
    for (const rec of records) {
      if (rec['类型'] === '长期记忆') {
        const cat = String(rec['分类'] || '')
        if (!categories.includes(cat)) continue
        const prev = longTerm.get(cat)
        if (!prev || sortKey(rec) >= sortKey(prev)) longTerm.set(cat, rec)
        continue
      }
      const k = keyOf(rec)
      const prev = plain.get(k)
      if (!prev || Object.keys(rec).length >= Object.keys(prev).length) plain.set(k, rec)
    }
    return { plain, longTerm }
  }

  function writeAll(records) {
    ensureLayout()
    const tmp = main + '.tmp'
    const body = records.map((r) => JSON.stringify(r)).join('\n')
    fs.writeFileSync(tmp, body ? body + '\n' : '', 'utf8')
    fs.renameSync(tmp, main)
  }

  function mergeIncoming({ verbose = false, log = console.log } = {}) {
    ensureLayout()
    const base = readJsonl(main)
    const inboxFiles = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => f.toLowerCase().endsWith('.jsonl')) : []
    if (inboxFiles.length === 0) return { added: 0, duplicates: 0, files: 0, total: base.length, moved: [] }

    const incoming = []
    for (const f of inboxFiles) incoming.push(...readJsonl(path.join(inbox, f)))

    const before = combine(base)
    const beforeKeys = new Set(before.plain.keys())
    const beforeCats = new Map([...before.longTerm].map(([k, v]) => [k, sortKey(v)]))

    const merged = combine(dedupeRecords([...base, ...incoming]))
    const addedPlain = [...merged.plain.keys()].filter((k) => !beforeKeys.has(k)).length
    const addedLong = [...merged.longTerm].filter(([k, v]) => {
      const prev = beforeCats.get(k)
      return prev === undefined || sortKey(v) > prev
    }).length
    const added = addedPlain + addedLong

    const ordered = [
      ...[...merged.plain.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
      ...[...merged.longTerm.values()].sort((a, b) => String(a['分类']).localeCompare(String(b['分类']))),
    ]
    writeAll(ordered)

    const moved = []
    const prefix = stamp().replace(/[: ]/g, '-')
    for (const f of inboxFiles) {
      const dest = path.join(archive, `${prefix}__${f}`)
      try { fs.renameSync(path.join(inbox, f), dest); moved.push(dest) } catch {}
    }
    if (verbose) log(`合并：${base.length} → ${ordered.length} 条（新增 ${added}，重复 ${incoming.length - added}）`)
    return { added, duplicates: incoming.length - added, files: inboxFiles.length, total: ordered.length, moved }
  }

  function appendRecord(rec) {
    ensureLayout()
    const type = String(rec['类型'] || '')
    // 写之前先看同一时间点有没有近似重复：有就不写，把已有的还回去。
    // 她常常把同一件事写两遍（措辞略差几个字），光靠"时间+内容"全等是拦不住的。
    if (type === '日记' || type === '今天') {
      const t = String(rec['时间'] || '')
      const sameSlot = readAll().filter((r) =>
        (r['类型'] === '日记' || r['类型'] === '今天') && String(r['时间'] || '') === t)
      for (const r of sameSlot) {
        if (dice(rec['内容'], r['内容']) >= NEAR_DUP) return { ...r, __duplicate: true }
      }
    }
    fs.appendFileSync(main, JSON.stringify(rec) + '\n', 'utf8')
    return rec
  }

  function countOn(datePrefix, type = '日记') {
    return readAll().filter((r) => r['类型'] === type && String(r['时间'] || '').startsWith(datePrefix)).length
  }

  function longTermMap() {
    const map = new Map()
    for (const rec of readAll()) {
      if (rec['类型'] === '长期记忆' && categories.includes(String(rec['分类']))) map.set(String(rec['分类']), rec)
    }
    return map
  }

  function longTermChars(map = longTermMap()) {
    let n = 0
    for (const rec of map.values()) for (const item of rec['条目'] || []) n += String(item['内容'] || '').length
    return n
  }

  function replaceCategory(category, items) {
    const cat = String(category || '')
    if (!categories.includes(cat)) throw new Error(`分类必须是：${categories.join(' / ')}`)
    const cleaned = (items || [])
      .map((x) => (typeof x === 'string' ? { 内容: x } : x))
      .map((x) => ({ 内容: String(x['内容'] || '').trim().slice(0, limits.factMax), 更新时间: String(x['更新时间'] || stamp()) }))
      .filter((x) => x['内容'])
      .slice(0, 40)

    const map = longTermMap()
    map.set(cat, { 类型: '长期记忆', 分类: cat, 条目: cleaned, 更新时间: stamp() })

    let archived = null
    if (cfg.longTerm?.archiveOnOverflow !== false) {
      while (longTermChars(map) > limits.totalMax && map.size > 1) {
        const cands = [...map.entries()].filter(([, v]) => (v['条目'] || []).length > 0)
        if (cands.length === 0) break
        cands.sort((a, b) => sortKey(a[1]).localeCompare(sortKey(b[1])))
        const [name, rec] = cands[0]
        if (name === cat && cands.length === 1) break
        map.delete(name)
        archived = name
        appendRecord({ 类型: '归档', 分类: name, 条目: rec['条目'], 归档时间: stamp() })
      }
    }

    const keep = readAll().filter((r) => !(r['类型'] === '长期记忆'))
    writeAll([...keep, ...map.values()])
    return { category: cat, count: cleaned.length, archived }
  }

  function search(keyword, limit = 20) {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return []
    const hits = []
    for (const rec of readAll()) {
      if (rec['类型'] === '长期记忆') {
        for (const item of rec['条目'] || []) {
          if (!String(item['内容'] || '').toLowerCase().includes(kw)) continue
          const body = String(item['内容'] || '')
          const uKey = `长期记忆|${rec['分类'] || ''}|${body.replace(/\s+/g, ' ').trim().slice(0, 40)}`
          const c = clarityOf({ 时间: item['更新时间'] || rec['更新时间'], 内容: body }, uKey)
          hits.push({
            类型: '长期记忆', 分类: rec['分类'], 时间: item['更新时间'], 内容: body,
            清晰度: round2(c), 记得: tierOf(c), __key: uKey,
          })
        }
        continue
      }
      const blob = JSON.stringify(rec).toLowerCase()
      if (!blob.includes(kw)) continue
      const c = clarityOf(rec)
      hits.push({
        类型: rec['类型'],
        时间: rec['时间'] || rec['归档时间'],
        内容: rec['内容'] || (rec['条目'] || []).map((x) => x['内容']).join('；'),
        清晰度: round2(c),
        记得: tierOf(c),
        ...(rec['重要'] === true ? { 重要: true } : {}),
        __key: keyOf(rec),
      })
    }
    const top = hits
      .sort((a, b) => String(b['时间'] || '').localeCompare(String(a['时间'] || '')))
      .slice(0, limit)
    // 翻过 = 想起来过一次：热度记账，下次这条更清楚一点。
    touchUsage(top.map((h) => h.__key))
    return top.map(({ __key, ...rest }) => rest)
  }

  function buildBriefing({ maxChars = num(cfg.inject?.maxChars, 2000) } = {}) {
    const all = readAll()
    const map = longTermMap()
    const diary = all.filter((r) => r['类型'] === '日记').slice(-5).reverse()
    const today = all.filter((r) => r['类型'] === '今天').slice(-1)[0]

    const lines = []
    if (map.size > 0) {
      lines.push('【你记住的大事】')
      for (const cat of categories) {
        const rec = map.get(cat)
        if (!rec) continue
        const items = (rec['条目'] || []).map((x) => x['内容'])
        if (items.length) lines.push(`- ${cat}：${items.join('；')}`)
      }
    }
    if (today) lines.push('', '【上次下班前你记的】', `- ${today['内容']}`)
    if (diary.length) {
      lines.push('', '【你最近写的日记】')
      for (const d of diary) lines.push(`- ${d['时间']}${d['心情'] ? `（${d['心情']}）` : ''}：${d['内容']}`)
    }
    // 分层遗忘的出口：淡下去的不进简报正文（省位置），只在尾巴上留一句它们还在。
    const plain = all.filter((r) => r['类型'] === '日记' || r['类型'] === '今天')
    const faded = plain.filter((r) => clarityOf(r) < 0.35)
    if (faded.length) {
      lines.push('', `【另有 ${faded.length} 条旧记忆淡了：要用 diary_recall 翻，翻出来也别当清清楚楚的事说】`)
    }
    const text = lines.join('\n')
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…（后面省略）' : text
  }

  // 一次性清理：把文件里已有的近似重复去掉
  function dedupe() {
    const all = readAll()
    const merged = combine(dedupeRecords(all))
    const ordered = [
      ...[...merged.plain.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
      ...[...merged.longTerm.values()].sort((a, b) => String(a['分类']).localeCompare(String(b['分类']))),
    ]
    writeAll(ordered)
    return { before: all.length, after: ordered.length, removed: all.length - ordered.length }
  }
  function stats() {
    const all = readAll()
    return {
      total: all.length,
      diary: all.filter((r) => r['类型'] === '日记').length,
      today: all.filter((r) => r['类型'] === '今天').length,
      longTerm: all.filter((r) => r['类型'] === '长期记忆').length,
      archived: all.filter((r) => r['类型'] === '归档').length,
      longTermChars: longTermChars(),
      faded: all.filter((r) => (r['类型'] === '日记' || r['类型'] === '今天') && clarityOf(r) < 0.35).length,
      usageEntries: Object.keys(loadUsage()).length,
      path: main,
    }
  }

  return {
    root, main, inbox, archive, categories, limits,
    ensureLayout, readAll, mergeIncoming, appendRecord, countOn,
    longTermMap, longTermChars, replaceCategory, search, buildBriefing, stats, dedupe,
    clarityOf, tierOf, touchUsage,
  }
}
