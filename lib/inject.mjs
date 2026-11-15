// lib/inject.mjs —— 原生注入：每天首轮把记忆简报塞进提示词
//
// 不再依赖提示词里"叫她自己调 diary_briefing"，而是由插件在合适的时机把
// 简报作为一条 user 消息追加到这一步里。
//
// 用到的宿主 API（从 app.asar 里确认过）：
//   ctx.agents.list()                 实时 agent 列表
//   agentCtx.on('agent/pre-step', fn) 步骤组装前的钩子，可以往 decision.messages 追加
//   @deepseek-ai/dsh-llm 的 createUserMessage  构造一条合法的 user 消息
//
// 全部包在 try/catch 里：注入失败只记日志，绝不影响插件其它功能。

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

const DAY_KEY = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 判断某个 session 是不是「群聊」。
// 为什么需要：记忆简报里有他的日记、作息、私事 —— 私聊里说没问题，
// 但群里有二十几个陌生人看着，绝不能把这段塞进群会话的上下文。
// 桥接的 state/sessions.json 里有 key（group:xxx / private:xxx）→ sessionId 的映射。
function buildSessionKeyLookup(sessionsFile, log) {
  let cache = { mtime: 0, map: new Map() }
  return (sessionId) => {
    try {
      if (!sessionsFile || !fs.existsSync(sessionsFile)) return ''
      const st = fs.statSync(sessionsFile)
      if (st.mtimeMs !== cache.mtime) {
        const j = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
        const map = new Map()
        for (const [key, sid] of Object.entries(j?.sessions ?? {})) map.set(String(sid), key)
        cache = { mtime: st.mtimeMs, map }
      }
      return cache.map.get(String(sessionId)) ?? ''
    } catch { return '' }
  }
}

export async function setupInjection(ctx, cfg, store, log) {
  const state = {
    lastDay: new Map(),   // sessionId -> 'YYYY-MM-DD'
  }

  // sessionId → 会话 key（group:xxx / private:xxx），用来识别群聊
  const lookupKey = buildSessionKeyLookup(
    cfg.inject?.sessionsFile || 'D:\\Ayu\\qq-bridge\\state\\sessions.json',
    log,
  )

  // 尽量拿到宿主的消息构造器；拿不到就退回普通对象（形状与 createUserMessage 一致）
  let createUserMessage = null
  try {
    const { loadHostModule } = await import('./hostdeps.mjs')
    const llm = await loadHostModule('@deepseek-ai/dsh-llm')
    createUserMessage = llm?.createUserMessage ?? null
  } catch {}
  log(createUserMessage ? '注入：拿到宿主的 createUserMessage' : '注入：用本地消息形状（没拿到 createUserMessage）')

  const buildMessage = (text) => {
    const body = {
      content: [{ type: 'text', text }],
      source: { kind: 'diary-memory', form: 'notice', summary: '记忆简报' },
    }
    if (createUserMessage) {
      try { return createUserMessage(body) } catch { /* 退回本地构造 */ }
    }
    // 与宿主 createMessage 完全同形：role + content + source + 新 id，且深冻结
    return Object.freeze({ id: randomUUID(), role: 'user', ...body })
  }

  const attach = (agent) => {
    const agentCtx = agent?.ctx
    if (!agentCtx?.on) return
    try {
      agentCtx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          if (decision?.kind !== 'enter') return decision
          const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
          const today = DAY_KEY()
          if (state.lastDay.get(sessionId) === today) return decision

          // 只给她（QQ 桥接的会话）注入，别污染其它会话（比如 DSH 主界面这个）
          const header = agent?.session?.header ?? {}
          const cwd = String(header.cwd ?? '')
          const preset = String(header.agentPreset ?? '')
          const onlyQq = cfg.inject?.onlyQqSessions !== false
          const isQq = /qq-bridge/i.test(cwd) || /^qq-chat/.test(preset)
          if (onlyQq && !isQq) {
            if (!state.skipLogged) { state.skipLogged = new Set() }
            if (!state.skipLogged.has(sessionId)) {
              state.skipLogged.add(sessionId)
              log(`注入：跳过非 QQ 会话 ${sessionId.slice(0, 12)}…（cwd=${cwd || '?'}）`)
            }
            return decision
          }

          // 群聊不注入私密简报：里面有他的日记、作息、私事，二十几个陌生人看着
          if (cfg.inject?.skipGroupSessions !== false) {
            const key = lookupKey(sessionId)
            if (key.startsWith('group:')) {
              if (!state.groupLogged) { state.groupLogged = new Set() }
              if (!state.groupLogged.has(sessionId)) {
                state.groupLogged.add(sessionId)
                log(`注入：跳过群聊会话 ${key}（不把私密简报塞进群里）`)
              }
              return decision
            }
          }

          const text = store.buildBriefing()
          if (!text) return decision

          state.lastDay.set(sessionId, today)
          const extra = buildMessage(text)
          log(`注入：${sessionId.slice(0, 12)}… 今天第一次，塞了 ${text.length} 字简报`)
          return { ...decision, messages: [...decision.messages, extra] }
        } catch (e) {
          log(`注入失败（不影响本轮）：${e?.message ?? e}`)
          return decision
        }
      }, { prepend: true })
      log(`注入：已挂到 agent ${String(agent?.id ?? '').slice(0, 12)}…`)
    } catch (e) {
      log(`注入：挂载失败 ${e?.message ?? e}`)
    }
  }

  // 已有的 agent 先挂上
  try {
    const list = ctx.agents?.list?.() ?? []
    for (const a of list) attach(a)
    log(`注入：现有 agent ${list.length} 个`)
  } catch (e) { log(`注入：枚举 agent 失败 ${e?.message ?? e}`) }

  // 之后新建的 agent 也挂上
  try {
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent ?? payload
      if (agent) attach(agent)
    })
  } catch (e) { log(`注入：监听 agent/created 失败 ${e?.message ?? e}`) }
}
