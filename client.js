/**
 * dsh-diary-memory —— 浏览器半端（设置在「设置」里的一页）
 * ============================================================================
 * 约定（从官方与第三方插件里挖出来的）：
 *   · 这不是 ESM，是**自注册脚本**：window.__ModuleLoader__.load({ id, factory })
 *   · id 必须等于 package.json 的 name，否则 "loaded without registering"
 *   · 进「设置」用 slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))
 *
 * 页面只做一件事：把 /api/diary-memory/config 的开关摊成表单，改完保存。
 * 不做花哨交互 —— 这是自用工具，能改、能看见状态就够。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-diary-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/diary-memory'

    const CSS = `
[data-dm-page]{display:flex;flex-direction:column;gap:16px;padding:4px 2px 12px;max-width:720px;}
[data-dm-card]{border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:12px 14px;}
[data-dm-card] > h4{margin:0 0 10px;font-size:13px;font-weight:600;opacity:.85;}
[data-dm-row]{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px;}
[data-dm-row] > span{opacity:.9;}
[data-dm-row] input[type=number]{width:110px;}
[data-dm-row] input[type=text]{width:280px;}
[data-dm-note]{font-size:12px;opacity:.6;line-height:1.6;}
[data-dm-actions]{display:flex;gap:10px;flex-wrap:wrap;}
[data-dm-ok]{color:#3a9a55;font-size:12px;}
[data-dm-err]{color:#c0392b;font-size:12px;}
`

    const jget = async (p) => {
      const res = await fetch(API + p, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const jpost = async (p) => {
      const res = await fetch(API + p, { method: 'POST', credentials: 'same-origin' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const jsave = async (patch) => {
      const res = await fetch(API + '/config', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    function setIn(obj, path, value) {
      const out = Array.isArray(obj) ? [...obj] : { ...obj }
      let cur = out
      for (let i = 0; i < path.length - 1; i++) {
        const k = path[i]
        cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...(cur[k] || {}) }
        cur = cur[k]
      }
      cur[path[path.length - 1]] = value
      return out
    }

    function Row({ label, children, hint }) {
      return h('div', { 'data-dm-row': '' },
        h('span', null, label, hint ? h('span', { 'data-dm-note': '' }, ' ' + hint) : null),
        children)
    }

    function Num({ value, onChange, min }) {
      return h('input', {
        type: 'number',
        min: min ?? 0,
        value: value ?? 0,
        onChange: (e) => onChange(Number(e.target.value)),
      })
    }

    function Box({ value, onChange }) {
      return h('input', { type: 'checkbox', checked: !!value, onChange: (e) => onChange(e.target.checked) })
    }

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [stats, setStats] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = async () => {
        try {
          const c = await jget('/config')
          setCfg(c.config)
          const s = await jget('/stats')
          setStats(s.stats)
          setMsg(null)
        } catch (e) { setMsg({ err: String(e.message || e) }) }
      }
      React.useEffect(() => { load() }, [])

      if (!cfg) return h('div', { 'data-dm-page': '' }, h('div', { 'data-dm-note': '' }, '读取配置中…'))

      const up = (path, v) => setCfg(setIn(cfg, path, v))
      const save = async () => {
        setBusy(true)
        try { await jsave(cfg); setMsg({ ok: '已保存（重启 DSH 后生效的部分：合并间隔、备份、注入开关）' }) }
        catch (e) { setMsg({ err: String(e.message || e) }) }
        setBusy(false)
      }
      const act = async (p, label) => {
        setBusy(true)
        try {
          const r = await jpost(p)
          setMsg({ ok: label + '：' + (r.files != null ? `处理 ${r.files} 个文件，新增 ${r.added} 条` : (r.dest ? '完成 ' + r.dest : '完成')) })
          await load()
        } catch (e) { setMsg({ err: String(e.message || e) }) }
        setBusy(false)
      }

      return h('div', { 'data-dm-page': '' },

        h('div', { 'data-dm-card': '' },
          h('h4', null, '状态'),
          stats
            ? h('div', { 'data-dm-note': '' },
                `共 ${stats.total} 条：日记 ${stats.diary} / 今天 ${stats.today} / 长期记忆 ${stats.longTerm} / 归档 ${stats.archived}；长期记忆 ${stats.longTermChars} 字`,
                h('br'), stats.path)
            : h('div', { 'data-dm-note': '' }, '读取中…'),
          h('div', { 'data-dm-actions': '', style: { marginTop: '8px' } },
            h('button', { disabled: busy, onClick: () => act('/merge', '合并') }, '立即合并「传入」'),
            h('button', { disabled: busy, onClick: () => act('/backup', '备份') }, '立即备份'),
            h('button', { disabled: busy, onClick: load }, '刷新'))),

        h('div', { 'data-dm-card': '' },
          h('h4', null, '总开关'),
          h(Row, { label: '启用记忆插件' }, h(Box, { value: cfg.enabled, onChange: (v) => up(['enabled'], v) }))),

        h('div', { 'data-dm-card': '' },
          h('h4', null, '日记'),
          h(Row, { label: '每天最多几条' }, h(Num, { value: cfg.diary?.perDay, onChange: (v) => up(['diary', 'perDay'], v), min: 1 })),
          h(Row, { label: '软提示字数', hint: '超过只是提醒她写短点' }, h(Num, { value: cfg.diary?.softLimit, onChange: (v) => up(['diary', 'softLimit'], v) })),
          h(Row, { label: '硬拒绝字数', hint: '超过直接不写' }, h(Num, { value: cfg.diary?.hardLimit, onChange: (v) => up(['diary', 'hardLimit'], v) }))),

        h('div', { 'data-dm-card': '' },
          h('h4', null, '今天'),
          h(Row, { label: '字数上限' }, h(Num, { value: cfg.today?.maxLength, onChange: (v) => up(['today', 'maxLength'], v) }))),

        h('div', { 'data-dm-card': '' },
          h('h4', null, '长期记忆'),
          h(Row, { label: '单条字数上限' }, h(Num, { value: cfg.longTerm?.factMax, onChange: (v) => up(['longTerm', 'factMax'], v) })),
          h(Row, { label: '总字数上限' }, h(Num, { value: cfg.longTerm?.totalMax, onChange: (v) => up(['longTerm', 'totalMax'], v) })),
          h(Row, { label: '超限时归档而不是删' }, h(Box, { value: cfg.longTerm?.archiveOnOverflow, onChange: (v) => up(['longTerm', 'archiveOnOverflow'], v) }))),

        h('div', { 'data-dm-card': '' },
          h('h4', null, '合并'),
          h(Row, { label: '定时合并间隔（分钟）' }, h(Num, { value: cfg.merge?.intervalMinutes, onChange: (v) => up(['merge', 'intervalMinutes'], v), min: 1 })),
          h(Row, { label: '启动时先合并一次' }, h(Box, { value: cfg.merge?.onStartup, onChange: (v) => up(['merge', 'onStartup'], v) }))),

        h('div', { 'data-dm-card': '' },
          h('h4', null, '备份'),
          h(Row, { label: '启用自动备份' }, h(Box, { value: cfg.backup?.enabled, onChange: (v) => up(['backup', 'enabled'], v) })),
          h(Row, { label: '目标目录' }, h('input', {
            type: 'text',
            value: cfg.backup?.target ?? '',
            onChange: (e) => up(['backup', 'target'], e.target.value),
          })),
          h(Row, { label: '保留份数' }, h(Num, { value: cfg.backup?.keep, onChange: (v) => up(['backup', 'keep'], v), min: 1 })),
          h(Row, { label: '每天只备份一次' }, h(Box, { value: cfg.backup?.oncePerDay, onChange: (v) => up(['backup', 'oncePerDay'], v) }))),

        h('div', { 'data-dm-card': '' },
          h('h4', null, '注入'),
          h(Row, { label: '每天首轮自动注入简报' }, h(Box, { value: cfg.inject?.dailyBriefing, onChange: (v) => up(['inject', 'dailyBriefing'], v) })),
          h(Row, { label: '只给 QQ 会话注入', hint: '别污染 DSH 主界面' }, h(Box, { value: cfg.inject?.onlyQqSessions !== false, onChange: (v) => up(['inject', 'onlyQqSessions'], v) })),
          h(Row, { label: '简报字数上限' }, h(Num, { value: cfg.inject?.maxChars, onChange: (v) => up(['inject', 'maxChars'], v) }))),

        h('div', { 'data-dm-actions': '' },
          h('button', { disabled: busy, onClick: save }, '保存'),
          h('button', { disabled: busy, onClick: load }, '放弃修改')),

        msg && msg.ok ? h('div', { 'data-dm-ok': '' }, msg.ok) : null,
        msg && msg.err ? h('div', { 'data-dm-err': '' }, msg.err) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-diary-memory')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-diary-memory: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'diary-memory', order: 40, label: '记忆（日记）' },
          () => h(Panel),
        ))
      },
    }
  },
})
