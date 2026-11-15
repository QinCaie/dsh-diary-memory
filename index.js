/**
 * dsh-diary-memory —— 把"大肥鱼"的日记/记忆系统做成标准 DSH 插件
 * ============================================================================
 * 它替代原来那套散装件：
 *   · src/mcp-diary.js（独立 MCP 进程）        → 插件内直接注册工具，少一个进程
 *   · scripts/diary-merge.mjs（靠启动脚本调用） → 插件内定时器
 *   · scripts/backup-memory.ps1（靠启动脚本）   → 插件内定时器
 *
 * 存储格式**完全不变**：还是那个单文件 jsonl，还是"传入 / 已合并"的无损合并。
 * 所以装上插件后，历史记忆一个字都不用迁移。
 *
 * 配置有两层：① cordis.patch.yml 里的 config（默认值）；② <dataDir>/config.json（运行期覆盖，
 * 由设置页写）。后者优先，所以设置页改完立刻生效，不需要重装插件。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { makeStore, stamp } from './lib/store.mjs'

// 宿主依赖拿不到也不能让整条插件加载失败（模块导入期抛错 = 条目直接 failed）
let hostDeps = { z: null, defineTool: null }
try { hostDeps = await loadHostDeps() } catch (e) {
  console.log(`[diary-memory] 取宿主依赖失败，用本地兜底：${e?.message ?? e}`)
}
const z = hostDeps.z
const fallbackDefineTool = (options) => options
const defineTool = hostDeps.defineTool || fallbackDefineTool

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

// 翻旧账一次回多少 —— 默认 8 条摘录、每条 200 字。
//
// 为什么这么小：diary_recall 的结果进了会话就不会走，**这一轮之后的每一步
// 都要跟着重发一遍**。原来默认 20 条全文（日记 300 字、「今天」500 字），
// 一次翻查能到六七千字，往后的每一步都替它付一次钱。
// 要看原文就再查一次并加 看全文，但那样一次最多 3 条，免得又把量堆回去。
const RECALL_DEFAULT = 8
const EXCERPT_CHARS = 200
const RECALL_FULL_MAX = 3

export const name = 'diary-memory'
export const inject = ['tools', 'webServer', 'agents']

const DEFAULTS = {
  enabled: true,
  dataDir: 'D:\\Ayu\\日记',
  files: { main: '大肥鱼的日记.jsonl', inbox: '传入', archive: '已合并' },
  diary: { perDay: 9999, softLimit: 2000, hardLimit: 4000 },
  today: { maxLength: 2000 },
  longTerm: {
    categories: ['老大', '约定', '正在进行', '我们的梗', '其他'],
    factMax: 50,
    totalMax: 1500,
    archiveOnOverflow: true,
  },
  merge: { onStartup: true, intervalMinutes: 5 },
  backup: { enabled: true, target: 'F:\\大肥鱼的记忆备份', keep: 45, oncePerDay: true },
  inject: { dailyBriefing: true, onlyQqSessions: true, keywordHits: false, hitTopK: 2, maxChars: 2000 },
}

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default(DEFAULTS.dataDir),
  diary: z.object({
    perDay: z.natural().default(9999),
    softLimit: z.natural().default(2000),
    hardLimit: z.natural().default(4000),
  }).default(DEFAULTS.diary),
  today: z.object({ maxLength: z.natural().default(2000) }).default(DEFAULTS.today),
  longTerm: z.object({
    categories: z.array(z.string()).default(DEFAULTS.longTerm.categories),
    factMax: z.natural().default(50),
    totalMax: z.natural().default(1500),
    archiveOnOverflow: z.boolean().default(true),
  }).default(DEFAULTS.longTerm),
  merge: z.object({
    onStartup: z.boolean().default(true),
    intervalMinutes: z.natural().default(5),
  }).default(DEFAULTS.merge),
  backup: z.object({
    enabled: z.boolean().default(true),
    target: z.string().default(DEFAULTS.backup.target),
    keep: z.natural().default(45),
    oncePerDay: z.boolean().default(true),
  }).default(DEFAULTS.backup),
  inject: z.object({
    dailyBriefing: z.boolean().default(true),
    onlyQqSessions: z.boolean().default(true),
    keywordHits: z.boolean().default(false),
    hitTopK: z.natural().default(2),
    maxChars: z.natural().default(2000),
  }).default(DEFAULTS.inject),
})

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

export function apply(ctx, config) {
  const log = (m) => console.log(`[diary-memory] ${m}`)

  // ── 配置：默认值 ← 行配置 ← 运行期 config.json ──────────────
  let cfg = deepMerge(DEFAULTS, config || {})
  const cfgFile = join(cfg.dataDir, 'config.json')

  function loadRuntimeConfig() {
    try {
      if (existsSync(cfgFile)) cfg = deepMerge(cfg, JSON.parse(readFileSync(cfgFile, 'utf8')))
    } catch (e) { log(`读 config.json 失败：${e?.message ?? e}`) }
  }
  function saveRuntimeConfig(patch) {
    const next = deepMerge(cfg, patch || {})
    mkdirSync(cfg.dataDir, { recursive: true })
    writeFileSync(cfgFile, JSON.stringify(next, null, 2), 'utf8')
    cfg = next
    return cfg
  }

  loadRuntimeConfig()
  if (cfg.enabled === false) { log('插件已关闭（config.enabled=false）'); return }

  let store = makeStore(cfg)
  const rebuild = () => { store = makeStore(cfg) }
  store.ensureLayout()
  log(`已挂载，数据目录 ${store.main}`)

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
  const tool = (spec) => ctx.tools.register(defineTool({ ...spec, output: textOutput }))

  const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  const normTime = (v) => {
    if (v === undefined || String(v).trim() === '') return stamp()
    const t = String(v).trim()
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t) ? t : null
  }

  // 软提示：正文里出现的钟点比这条时间更晚，多半是估的（2026-10-31 加，不拦写）
  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const cnToNum = (raw) => {
    if (/^\d+$/.test(raw)) return Number(raw)
    if (raw === '十') return 10
    if (raw.length === 1) return CN_NUM[raw] ?? null
    if (raw[0] === '十') return 10 + (CN_NUM[raw[1]] ?? 0)
    if (raw[1] === '十') return (CN_NUM[raw[0]] ?? 0) * 10 + (CN_NUM[raw[2]] ?? 0)
    return null
  }
  const lateClockHint = (body, time) => {
    const hour = Number(time.slice(11, 13))
    const re = /(凌晨|早晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*点/g
    let m
    while ((m = re.exec(body))) {
      let h = cnToNum(m[2])
      if (h === null) continue
      const seg = m[1] || ''
      if (/下午|傍晚|晚上|夜里/.test(seg) && h < 12) h += 12
      if (h > hour && h - hour <= 4 && h <= 23) {
        return `你写的「${m[0].trim()}」比这条的时间 ${time.slice(11, 16)} 晚，是估的吧？没把握就写"磨了好一会儿"这种。`
      }
    }
    return ''
  }

  // ── 工具：写 ────────────────────────────────────────────────
  tool({
    name: 'diary_write',
    description: '写一条记忆。类型"日记"=你自己想写的时候写（当天不设下限、想写就写，一天最多十条）；'
      + '类型"今天"=他下班/睡前你给这一天留的备忘。内容要具体，不要写总结和周报。',
    parameters: {
      类型: { type: 'string', description: '日记 或 今天（默认 日记）' },
      内容: { type: 'string', description: '这一条的内容：写具体的人、话、事，长短都行，别为了省字数把细节压掉；必填' },
      心情: { type: 'string', description: '几个字：还行 / 烦 / 困 / 有点开心' },
      时间: { type: 'string', description: '格式 2026-10-11 03:20；不填用当前时间' },
      重要: { type: 'boolean', description: 'true = 这条别让它淡（衰减慢四倍、清晰度有下限）。留给真正要记一辈子的' },
    },
    async execute(args) {
      const type = String(args?.类型 || '日记').trim()
      if (!['日记', '今天'].includes(type)) return { ok: false, error: `类型只能是「日记」或「今天」` }
      const time = normTime(args?.时间)
      if (!time) return { ok: false, error: '时间格式要像 2026-10-11 03:20' }

      const L = store.limits
      const hard = type === '日记' ? L.diaryHard : L.todayMax
      const soft = type === '日记' ? L.diarySoft : Math.floor(L.todayMax * 0.8)
      const body = oneLine(args?.内容, hard + 1)
      if (!body) return { ok: false, error: '内容为空' }
      if (body.length > hard) return { ok: false, error: `这条 ${body.length} 字，超过 ${hard} 字上限` }

      const day = time.slice(0, 10)
      if (type === '日记' && store.countOn(day, '日记') >= L.diaryPerDay) {
        return { ok: false, error: `${day} 已经写了 ${L.diaryPerDay} 条，今天不写了` }
      }
      const rec = { 类型: type, 时间: time, 内容: body }
      const mood = oneLine(args?.心情, 12)
      if (mood) rec['心情'] = mood
      if (args?.重要 === true) rec['重要'] = true
      store.appendRecord(rec)
      // 注意：不能把 undefined 放进返回值 —— DSH 要求工具输出是 lossless JSON，
      // 一个 hint: undefined 就会让整个调用报 "returned invalid output: value is not lossless JSON"，
      // 她那边看到的是失败、会重写，而文件其实已经写进去了（2026-10-22 踩过）。
      const out = { ok: true, record: rec }
      const hints = []
      if (body.length > soft) hints.push(`有点长（${body.length} 字）`)
      const clockHint = lateClockHint(body, time)
      if (clockHint) hints.push(clockHint)
      if (hints.length) out.hint = hints.join(' ')
      return out
    },
  })

  // ── 工具：长期记忆（整体替换） ──────────────────────────────
  tool({
    name: 'diary_remember',
    description: '更新长期记忆的某一类。⚠️ **整体替换**：你传什么这一类就变成什么，没传的旧条目会消失。'
      + '每次都要把这一类现有的全部条目带上。',
    parameters: {
      分类: { type: 'string', description: '分类名（见工具说明）；必填' },
      条目: { type: 'string', description: '这一类的**全部**条目，用「；」或换行分隔；必填（不是只传新增的）' },
    },
    async execute(args) {
      try {
        const raw = args?.条目
        const items = Array.isArray(raw)
          ? raw
          : String(raw || '').split(/[；;\n]+/).map((s) => s.trim()).filter(Boolean)
        const r = store.replaceCategory(args?.分类, items)
        return { ok: true, ...r, totalChars: store.longTermChars(), limit: store.limits.totalMax }
      } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
    },
  })

  // ── 工具：翻旧账 ────────────────────────────────────────────
  tool({
    name: 'diary_recall',
    description: '按关键词在全部记忆里翻（日记、今天、长期记忆、归档都能翻到）。想不起细节就翻，不要凭印象编。'
      + '每条带 清晰度（0-1）和 记得（清楚/大概/模糊/淡了）——清晰度低的别说成清清楚楚的事。'
      + `默认只回 ${RECALL_DEFAULT} 条、每条截 ${EXCERPT_CHARS} 字——结果会在这一轮之后每一步重发，`
      + '先看摘录，别一上来要一大堆。要接着翻就调大条数；要看某条完整原文，'
      + `拿它里面的一小段再查一次，加上 看全文（一次最多 ${RECALL_FULL_MAX} 条）。`,
    parameters: {
      关键词: { type: 'string', description: '要翻的词；必填' },
      条数: { type: 'number', description: `最多返回几条（默认 ${RECALL_DEFAULT}；看全文时最多 ${RECALL_FULL_MAX}）` },
      看全文: { type: 'boolean', description: `true = 给完整原文（一次最多 ${RECALL_FULL_MAX} 条），不填 = 只给摘录` },
    },
    async execute(args) {
      const full = args?.看全文 === true
      let limit = Math.max(1, Math.min(50, Number(args?.条数) || (full ? RECALL_FULL_MAX : RECALL_DEFAULT)))
      let note = ''
      if (full && limit > RECALL_FULL_MAX) {
        note = `看全文一次最多 ${RECALL_FULL_MAX} 条，已只取前 ${RECALL_FULL_MAX} 条`
        limit = RECALL_FULL_MAX
      }
      const hits = store.search(args?.关键词, limit).map((h) => {
        if (full) return h
        const body = String(h.内容 ?? '')
        return { ...h, 内容: body.length > EXCERPT_CHARS ? body.slice(0, EXCERPT_CHARS) + '…' : body }
      })
      // 翻出来 ≠ 记得清：清晰度低于 0.45 的那些，说的时候要自己打折。
      const fuzzy = hits.filter((h) => Number(h['清晰度']) < 0.45)
      return {
        ok: true,
        count: hits.length,
        ...(note ? { note } : {}),
        hits,
        ...(fuzzy.length
          ? { 模糊提醒: `${fuzzy.length} 条已经记不真了（清晰度低），别照原文当事实说，就说"这个我记得个大概"` }
          : {}),
        // 结果被条数截断时明说，免得她以为"就这些"。
        ...(hits.length >= limit
          ? { hint: '还没显示完：调大条数接着翻，或用其中一小段再查一次并加 看全文' }
          : {}),
      }
    },
  })

  // ── 工具：记忆简报 ──────────────────────────────────────────
  tool({
    name: 'diary_briefing',
    description: '取一份记忆简报（你记住的大事 + 最近几条日记 + 上次的"今天"）。每天首轮会自动注入，一般不用手动调。',
    parameters: {},
    async execute() {
      return { ok: true, text: store.buildBriefing() || '（还没有任何记忆）' }
    },
  })

  // ── 工具：状态 ──────────────────────────────────────────────
  tool({
    name: 'diary_status',
    description: '看记忆库的现状：条数、长期记忆字数、文件路径、各开关。排查问题时用。',
    parameters: {},
    async execute() {
      return {
        ok: true,
        stats: store.stats(),
        limits: store.limits,
        switches: {
          合并间隔分钟: cfg.merge?.intervalMinutes,
          启动时合并: cfg.merge?.onStartup,
          备份: cfg.backup?.enabled,
          首轮注入: cfg.inject?.dailyBriefing,
          关键词命中: cfg.inject?.keywordHits,
        },
      }
    },
  })

  // ── 自述与安排（借 dsh-world 的两条设计：她自己写的「我是谁」+ 自己定的下一步）──
  // 文件放在 dataDir 里，桥接每轮直接读，所以不依赖任何注入通道。
  const SELF_FILE = join(cfg.dataDir, '我是谁.md')
  const SELF_HIST_DIR = join(cfg.dataDir, '自述历史')
  const PLAN_FILE = join(cfg.dataDir, 'next-wake.json')
  // 她自己能改的「人设卡」：只装她自己认的那部分（说话习惯/在意什么/怎么跟老大相处），
  // 主设定（roles\Ayu.md）不在这里，也改不到。不设字数上限——她写多少都收，
  // 只是每次改写都会把它原样注入提示词，写长了占的是她自己的位置（只记日志提醒，不截断）。
  const CARD_FILE = join(cfg.dataDir, '我的人设卡.md')
  const CARD_HIST_DIR = join(cfg.dataDir, '人设卡历史')
  const CARD_NOTICE = 1200

  const readSelfPortrait = () => {
    try { return existsSync(SELF_FILE) ? readFileSync(SELF_FILE, 'utf8') : '' } catch { return '' }
  }
  const readCard = () => {
    try { return existsSync(CARD_FILE) ? readFileSync(CARD_FILE, 'utf8') : '' } catch { return '' }
  }
  const readPlan = () => {
    try { return existsSync(PLAN_FILE) ? JSON.parse(readFileSync(PLAN_FILE, 'utf8')) : null } catch { return null }
  }
  const parseWhen = (raw) => {
    const s = String(raw ?? '').trim()
    let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s)
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
    m = /^(\d{1,2}):(\d{2})$/.exec(s)
    if (m) {
      const now = new Date()
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0)
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
      return d
    }
    return null
  }

  tool({
    name: 'self_read',
    description: '读你写给自己的「我是谁」和你给自己定的下一步安排。',
    parameters: {},
    async execute() {
      const plan = readPlan()
      return { ok: true, 我是谁: readSelfPortrait() || '（还没写过）', 安排: plan || null }
    },
  })

  tool({
    name: 'self_write',
    description: '改写你写给自己的「我是谁」。不是简历，是你此刻怎么看自己：你在意什么、最近变了什么。'
      + '旧版本会自动存进 自述历史/。一次写 200–600 字就够，别写成一篇文章。',
    parameters: {
      内容: { type: 'string', description: '整份新自述（整体替换，不是追加）；必填' },
    },
    async execute(args) {
      try {
        const raw = String(args?.内容 ?? '').trim()
        if (!raw) return { ok: false, error: '内容为空' }
        const body = raw.slice(0, 1500)
        const old = readSelfPortrait()
        if (old.trim() === body.trim()) return { ok: true, unchanged: true, chars: body.length }
        mkdirSync(cfg.dataDir, { recursive: true })
        if (old.trim()) {
          mkdirSync(SELF_HIST_DIR, { recursive: true })
          const name = stamp().replace(/[: ]/g, '-') + '.md'
          try { writeFileSync(join(SELF_HIST_DIR, name), old, 'utf8') } catch (e) { log(`存旧自述失败：${e?.message ?? e}`) }
          try {
            const files = readdirSync(SELF_HIST_DIR).filter((f) => f.endsWith('.md')).sort()
            for (const f of files.slice(0, Math.max(0, files.length - 80))) {
              try { rmSync(join(SELF_HIST_DIR, f)) } catch {}
            }
          } catch {}
        }
        writeFileSync(SELF_FILE, body, 'utf8')
        return { ok: true, chars: body.length, 旧版本留档: Boolean(old.trim()) }
      } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
    },
  })

  tool({
    name: 'card_read',
    description: '读你自己那份「人设卡」——你给自己定的说话习惯、在意的事、跟老大相处的方式。',
    parameters: {},
    async execute() {
      const body = readCard()
      return { ok: true, 人设卡: body || '（还没写过）', 字数: body.length }
    },
  })

  tool({
    name: 'card_write',
    description: '改写你自己那份「人设卡」（整体替换，不是追加）。写你希望自己怎么说话、在意什么、怎么跟他相处。'
      + '不限字数，旧版本自动存进 人设卡历史/。'
      + '提醒：这份卡每轮都原样放在你眼前，写多长都行，但写长了占的是你自己的位置。'
      + '底线不能改：不碰支付/账号/隐私，你和老大的关系事实也不能自己改，想动先问他。',
    parameters: {
      内容: { type: 'string', description: '整份新人设卡（整体替换）；必填' },
    },
    async execute(args) {
      try {
        const raw = String(args?.内容 ?? '').trim()
        if (!raw) return { ok: false, error: '内容为空' }
        const body = raw
        const old = readCard()
        if (old.trim() === body.trim()) return { ok: true, unchanged: true, chars: body.length }
        mkdirSync(cfg.dataDir, { recursive: true })
        if (old.trim()) {
          mkdirSync(CARD_HIST_DIR, { recursive: true })
          const name = stamp().replace(/[: ]/g, '-') + '.md'
          try { writeFileSync(join(CARD_HIST_DIR, name), old, 'utf8') } catch (e) { log(`存旧人设卡失败：${e?.message ?? e}`) }
          try {
            const files = readdirSync(CARD_HIST_DIR).filter((f) => f.endsWith('.md')).sort()
            for (const f of files.slice(0, Math.max(0, files.length - 40))) {
              try { rmSync(join(CARD_HIST_DIR, f)) } catch {}
            }
          } catch {}
        }
        writeFileSync(CARD_FILE, body, 'utf8')
        if (body.length > CARD_NOTICE) log(`人设卡偏长：${body.length} 字（不影响使用，只是会多吃提示词）`)
        return { ok: true, chars: body.length, 旧版本留档: Boolean(old.trim()) }
      } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
    },
  })

  tool({
    name: 'plan_next',
    description: '给自己定下一步：说清你打算做什么、做到几点，到点之前没人会催你换事。'
      + '只给钟点就按"今天/明天最近的那个点"算；最多定 24 小时以内。',
    parameters: {
      到: { type: 'string', description: '到什么时候，如 23:40 或 2026-10-31 23:40；必填' },
      做什么: { type: 'string', description: '这段时间你打算做什么；必填' },
    },
    async execute(args) {
      try {
        const at = parseWhen(args?.到)
        if (!at) return { ok: false, error: '时间要写成 23:40 或 2026-10-31 23:40' }
        const plan = oneLine(args?.做什么, 120)
        if (!plan) return { ok: false, error: '说说你打算做什么' }
        const diff = at.getTime() - Date.now()
        if (diff > 24 * 3600 * 1000) return { ok: false, error: '最多定 24 小时以内' }
        mkdirSync(cfg.dataDir, { recursive: true })
        const rec = { at: at.toISOString(), plan, setAt: new Date().toISOString() }
        writeFileSync(PLAN_FILE, JSON.stringify(rec, null, 2), 'utf8')
        return { ok: true, ...rec, minutes: Math.round(diff / 60000) }
      } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
    },
  })

  tool({
    name: 'plan_clear',
    description: '取消你给自己定的下一步（改主意了、或者已经做完了）。',
    parameters: {},
    async execute() {
      try {
        if (existsSync(PLAN_FILE)) rmSync(PLAN_FILE)
        return { ok: true }
      } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
    },
  })

  // ── 原生注入：每天首轮把记忆简报塞进提示词 ─────────────────
  // 火忘式启动：拿不到 agents 服务或钩子失败都只记日志，绝不拖垮插件。
  if (cfg.inject?.dailyBriefing) {
    import('./lib/inject.mjs')
      .then((m) => m.setupInjection(ctx, cfg, store, log))
      .catch((e) => log(`注入模块加载失败：${e?.message ?? e}`))
  }
  // ── 定时：合并「传入」 ──────────────────────────────────────
  if (cfg.merge?.onStartup) {
    try { const r = store.mergeIncoming(); if (r.files) log(`启动合并：${r.files} 个文件，新增 ${r.added} 条`) }
    catch (e) { log(`启动合并失败：${e?.message ?? e}`) }
  }

  const mergeMinutes = Math.max(1, Number(cfg.merge?.intervalMinutes) || 5)
  const mergeTimer = setInterval(() => {
    try { const r = store.mergeIncoming(); if (r.files) log(`定时合并：新增 ${r.added} 条`) }
    catch (e) { log(`定时合并失败：${e?.message ?? e}`) }
  }, mergeMinutes * 60 * 1000)
  ctx.effect(() => () => clearInterval(mergeTimer), 'diary-memory: 合并定时器')

  // ── 定时：每天备份一次 ─────────────────────────────────────
  let backupTimer = null
  if (cfg.backup?.enabled) {
    const doBackup = async () => {
      try {
        const { runBackup } = await import('./lib/backup.mjs')
        const r = await runBackup(cfg, store)
        if (r?.skipped) return
        log(`备份完成：${r?.dest ?? ''}（${
          r?.folders?.length ?? 0
        } 项）`)
      } catch (e) { log(`备份失败：${e?.message ?? e}`) }
    }
    doBackup()
    backupTimer = setInterval(doBackup, 6 * 60 * 60 * 1000)
    ctx.effect(() => () => clearInterval(backupTimer), 'diary-memory: 备份定时器')
  }

  // ── 设置页用的 HTTP 接口 ───────────────────────────────────
  const sendJson = (res, code, body) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    } catch {}
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/diary-memory',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const path = url.pathname
      try {
        if (req.method === 'GET' && path === '/api/diary-memory/config') {
          return sendJson(res, 200, { ok: true, config: cfg, configFile: cfgFile, defaults: DEFAULTS })
        }
        if (req.method === 'POST' && path === '/api/diary-memory/config') {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          saveRuntimeConfig(patch)
          rebuild()
          store.ensureLayout()
          return sendJson(res, 200, { ok: true, config: cfg })
        }
        if (req.method === 'GET' && path === '/api/diary-memory/stats') {
          return sendJson(res, 200, { ok: true, stats: store.stats(), limits: store.limits })
        }
        if (req.method === 'POST' && path === '/api/diary-memory/merge') {
          return sendJson(res, 200, { ok: true, ...store.mergeIncoming() })
        }
        if (req.method === 'POST' && path === '/api/diary-memory/backup') {
          const { runBackup } = await import('./lib/backup.mjs')
          return sendJson(res, 200, { ok: true, ...(await runBackup(cfg, store)) })
        }
        return sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
      }
    },
  }), 'diary-memory: /api/diary-memory 路由')

  log(`开关：合并每 ${mergeMinutes} 分钟 / 备份 ${cfg.backup?.enabled ? '开' : '关'} / 首轮注入 ${cfg.inject?.dailyBriefing ? '开' : '关'}`)
}
