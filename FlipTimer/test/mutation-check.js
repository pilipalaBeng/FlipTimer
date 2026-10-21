/**
 * 变异测试（元测试）
 *
 * 宪法自检第一次跑就全绿，这不证明它有效——可能每一条都写得很松。
 * 这里故意把代码改坏，看对应条款能不能抓到。抓不到 = 该条款是摆设。
 *
 * 全程在系统临时目录的项目副本里做，不碰源文件。
 * 跑法：node test/mutation-check.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const SRC = path.resolve(__dirname, '..')
const NODE = process.execPath

function copyProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-const-'))
  const dst = path.join(base, 'proj')
  fs.cpSync(SRC, dst, { recursive: true })
  return { base, dst }
}

function runCheck(dir) {
  try {
    return execFileSync(NODE, ['test/constitution-check.js'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 90000,
    })
  } catch (e) {
    return String(e.stdout || '')
  }
}

function parseVerdicts(out) {
  const map = {}
  for (const line of out.split('\n')) {
    const m = line.match(/(PASS|FAIL)\s+(C-[\w.]+)/)
    if (m) map[m[2]] = m[1]
  }
  return map
}

/** 造一个超过 25 行的函数，用来打 C-6.5 */
function bloatMethod(lines) {
  const body = []
  for (let i = 0; i < lines; i++) body.push('    this.setData({})')
  return ['  bloat() {', ...body, '  },', '  noop() {},'].join('\n')
}

const CASES = [
  {
    id: 'C-2.1',
    desc: '偷加第五个状态 paused',
    file: 'pages/clock/index.js',
    from: "state: 'closed', mainText: ''",
    to: "state: 'paused', mainText: ''",
  },
  {
    id: 'C-2.2',
    desc: '在点击回调里直接改 state',
    file: 'pages/clock/index.js',
    from: "      this.collapseFab()\n      return\n    }\n    if (this.data.state !== 'alert') return\n    this.handleAction()",
    to: "      this.collapseFab()\n      return\n    }\n    if (this.data.state !== 'alert') return\n    this.setData({ state: 'running' })",
  },
  {
    id: 'C-2.6',
    desc: '结束文案退回系统播报体',
    file: 'pages/clock/index.js',
    from: "const NOTICE_CLOSED = '好了'",
    to: "const NOTICE_CLOSED = '已关闭提醒'",
  },
  {
    id: 'C-3.4',
    desc: '最后一分钟退回只显示时分（不亮秒）',
    file: 'pages/clock/index.js',
    from: 'const text = withSec ? formatHMS(new Date()) : formatHM(new Date())',
    to: 'const text = formatHM(new Date())',
  },
  {
    id: 'C-3.5',
    desc: '把剩余时间取整函数加回来（回归倒计时）',
    file: 'utils/format.js',
    from: 'module.exports = { pad2, formatHM, formatHMS, formatTarget }',
    to: 'function toCeilMinutes(ms) {\n  return Math.ceil(ms / 60000)\n}\nmodule.exports = { pad2, formatHM, formatHMS, formatTarget, toCeilMinutes }',
  },
  {
    id: 'C-3.6',
    desc: '中间区改回显示剩余分钟',
    file: 'pages/clock/index.js',
    from: 'this.setData({ mainText: text, finalPhase: withSec })',
    to: 'this.setData({ mainText: Math.ceil(this.countdown.remaining / 60000), finalPhase: withSec })',
  },
  {
    id: 'C-2.6',
    desc: 'closed 态底部重复一遍已关闭提醒',
    file: 'pages/clock/index.js',
    from: "this.setData({ state: 'closed', mainText: '', statusText: '', targetText: '', noticeText: text })",
    to: "this.setData({ state: 'closed', mainText: '', statusText: text, targetText: '', noticeText: text })",
  },
  {
    id: 'C-2.7',
    desc: '取消时忘了废弃目标时间戳',
    file: 'pages/clock/index.js',
    from: '    this.clearRound()\n    this.countdown.reset()\n    this.showClosed(NOTICE_CANCELED)',
    to: '    this.clearRound()\n    this.showClosed(NOTICE_CANCELED)',
  },
  {
    id: 'C-2.7',
    desc: '长按退回走 handleAction（取消失效）',
    file: 'pages/clock/index.js',
    from: '    if (state === \'running\') {\n      this.actionLockUntil = now + ACTION_LOCK_MS\n      this.cancelRound()',
    to: "    if (state === 'running') {\n      this.handleAction()",
  },
  {
    id: 'C-3.7',
    desc: '页面自己给 targetTs 赋值',
    file: 'pages/clock/index.js',
    from: '    this.countdown.reset()',
    to: '    this.countdown.targetTs = 0\n    this.countdown.reset()',
  },
  {
    id: 'C-3.8',
    desc: '提醒时刻退回只到分',
    file: 'utils/format.js',
    from: "return '提醒时间 ' + formatHMS(new Date(ts))",
    to: "return '提醒时间 ' + formatHM(new Date(ts))",
  },
  {
    id: 'C-4.2',
    desc: '翻转阈值从 150° 放宽到 60°，随手一晃就触发',
    file: 'utils/flip.js',
    from: 'const TURN_RAD = (Math.PI * 150) / 180',
    to: 'const TURN_RAD = (Math.PI * 60) / 180',
  },
  {
    id: 'C-4.2',
    desc: 'dt 忘了从毫秒换成秒，积分放大一千倍',
    file: 'utils/flip.js',
    from: '    return Math.min(gap, MAX_DT_MS) / 1000',
    to: '    return Math.min(gap, MAX_DT_MS)',
  },
  {
    id: 'C-4.2',
    desc: '退回只积 z 轴，横翻没反应',
    file: 'utils/flip.js',
    from: '    this.rx += v[0] * dt\n    this.ry += v[1] * dt\n    this.rz += v[2] * dt',
    to: '    this.rx = this.ry = 0\n    this.rz += v[2] * dt',
  },
  {
    id: 'C-4.2',
    desc: '总转角只看一根轴，复合运动被切碎',
    file: 'utils/flip.js',
    from: '    return Math.sqrt(this.rx * this.rx + this.ry * this.ry + this.rz * this.rz)',
    to: '    return Math.abs(this.rz)',
  },
  {
    id: 'C-4.3',
    desc: '提醒态翻转不关闭，用户得翻两次才关得掉',
    file: 'pages/clock/index.js',
    from: "    if (this.data.state === 'alert') return this.closeAlert()",
    to: "    if (this.data.state === 'alert') return",
  },
  {
    id: 'C-4.3',
    desc: '先渲染后记账，渲染出岔子动作就跟着消失',
    file: 'utils/flip.js',
    from: '    this.turns++\n    this.pending++\n    this._setPose(!this.upsideDown)',
    to: '    this.turns++\n    this._setPose(!this.upsideDown)\n    this.pending++',
  },
  {
    id: 'C-4.3',
    desc: 'onTick 不取队列，翻转动作永远堆着',
    file: 'pages/clock/index.js',
    from: '    const turns = this.flipDetector.takeTurns()',
    to: '    const turns = 0',
  },
  {
    id: 'C-4.5',
    desc: 'onHide 忘了停传感器',
    file: 'pages/clock/index.js',
    from: '    this.stopTick()\n    this.flipDetector.stop()',
    to: '    this.stopTick()',
  },
  {
    id: 'C-4.7',
    desc: '传感器失败既不降级也不上报',
    file: 'utils/flip.js',
    from: '    this.onUnavailable()',
    to: '    // 降级通知被删',
  },
  {
    id: 'C-4.8',
    desc: '陀螺仪采样频率改成耗电的 game',
    file: 'utils/flip.js',
    from: "    wx.startGyroscope({\n      interval: 'ui',",
    to: "    wx.startGyroscope({\n      interval: 'game',",
  },
  {
    id: 'C-5.1',
    desc: '存储 key 丢掉前缀',
    file: 'utils/prefs.js',
    from: "const KEY_DURATION = 'flip_timer_duration_min'",
    to: "const KEY_DURATION = 'duration_min'",
  },
  {
    id: 'C-5.4',
    desc: 'closeAlert 不再即刻清理',
    file: 'pages/clock/index.js',
    from: '    this.clearRound() // 关闭即清',
    to: '    // 清理已移除',
  },
  {
    id: 'C-6.5',
    desc: '塞一个 27 行的函数',
    file: 'pages/clock/index.js',
    from: '  noop() {},',
    to: bloatMethod(27),
  },
  {
    id: 'C-6.10',
    desc: '基础库版本调到隐私接口以下',
    file: 'project.config.json',
    from: '"libVersion": "3.5.5"',
    to: '"libVersion": "2.10.0"',
  },
  {
    id: 'C-7.2',
    desc: '用 px 写死字号',
    file: 'pages/clock/index.wxss',
    from: '  font-size: 42vh;',
    to: '  font-size: 160px;',
  },
  {
    id: 'C-7.4',
    desc: '复活已废弃的 drift 类',
    file: 'pages/clock/index.wxml',
    from: '<view class="main" bindlongpress="onMainLongPress">',
    to: '<view class="main drift-{{driftIndex}}" bindlongpress="onMainLongPress">',
  },
  {
    id: 'C-7.10',
    desc: '细棍点击区退回用 padding 凑高度',
    file: 'pages/clock/index.wxss',
    from: '  min-height: 7vh;\n  padding: 0 2.6vh;',
    to: '  padding: 2.6vh;',
  },
  {
    id: 'C-7.11',
    desc: '悬浮钮位置改回写死 vh/vw',
    file: 'pages/clock/index.js',
    from: '    this.setData({ fabStyle: fabStyle(menuRect()) })',
    to: "    this.setData({ fabStyle: 'top: 2vh; right: 4vw;' })",
  },
  {
    id: 'C-7.12',
    desc: '收起态菜单只调透明度，仍可点',
    file: 'pages/clock/index.wxss',
    from: '  gap: 1.2vh;\n  visibility: hidden;',
    to: '  gap: 1.2vh;',
  },
  {
    id: 'C-7.17',
    desc: '菜单里删掉「说明」入口',
    file: 'pages/clock/index.wxml',
    from: 'data-mode="help"',
    to: 'data-mode="glow"',
  },
  {
    id: 'C-7.12',
    desc: '计时中把悬浮钮藏起来',
    file: 'pages/clock/index.wxml',
    from: 'wx:if="{{!showPanel && state !== \'closed\'}}"',
    to: 'wx:if="{{!showPanel && state !== \'running\' && state !== \'closed\'}}"',
  },
  {
    id: 'C-2.7',
    desc: '计时态从菜单取消改成没反应',
    file: 'pages/clock/index.js',
    from: "    if (this.data.state === 'running') return this.cancelRound()",
    to: "    if (this.data.state === 'running') return",
  },
  {
    id: 'C-7.13',
    desc: '展开时点空白直接开计时',
    file: 'pages/clock/index.js',
    from: "  onStageTap() {\n    if (this.data.fabOpen) {\n      this.collapseFab()\n      return\n    }",
    to: '  onStageTap() {',
  },
  {
    id: 'C-2.8',
    desc: '面板开着时翻转照常启动计时',
    file: 'pages/clock/index.js',
    from: '    if (this.data.showPanel) return this.onClosePanel()',
    to: '    if (false) return this.onClosePanel()',
  },
  {
    id: 'C-4.2',
    desc: '断流判定放宽，挂起恢复被当成一次旋转',
    file: 'utils/flip.js',
    from: '    if (gap > STALL_MS) return null',
    to: '    if (gap > 10000) return null',
  },
  {
    id: 'C-4.2',
    desc: '积分上限收回 120ms，掉帧时把角度算小',
    file: 'utils/flip.js',
    from: 'const MAX_DT_MS = 250',
    to: 'const MAX_DT_MS = 120',
  },
  {
    id: 'C-4.1',
    desc: '模长下限改回写死绝对值，赌一种量纲',
    file: 'utils/flip.js',
    from: '  if (ref > 0 && mag < ref * MIN_MAG_RATIO) return null',
    to: '  if (mag < 0.35) return null',
  },
  {
    id: 'C-7.11',
    desc: '给内容加回 180° 补偿，和系统旋转叠成倒立',    file: 'pages/clock/index.wxml',
    from: '  <view class="flipper">',
    to: '  <view class="flipper" style="transform: rotate(180deg)">',
  },
  {
    id: 'C-7.11',
    desc: '姿态变了不重算悬浮钮位置',
    file: 'pages/clock/index.js',
    from: '  applyPose() {\n    this.placeFab()',
    to: '  applyPose() {',
  },
  {
    id: 'C-7.5',
    desc: '远场砍掉一条渐变带，只剩三边发光',
    file: 'utils/prefs.js',
    from: "      'linear-gradient(to left, ' + rgba(rgb, fa) + ', ' + zero + ')',",
    to: "      '',",
  },
  {
    id: 'C-7.5',
    desc: '渐变加中途 stop，屏幕上留下一条直边',
    file: 'utils/prefs.js',
    from: "'linear-gradient(to bottom, ' + rgba(rgb, fa) + ', ' + zero + ')'",
    to: "'linear-gradient(to bottom, ' + rgba(rgb, fa) + ' 0%, ' + zero + ' 34%)'",
  },
  {
    id: 'C-7.5',
    desc: '近场加回 spread，内沿变成断崖',
    file: 'utils/prefs.js',
    from: "'inset 0 0 ' + NEAR_R[i] + 'vh 0 ' + rgba(rgb, v)",
    to: "'inset 0 0 ' + NEAR_R[i] + 'vh 1.2vh ' + rgba(rgb, v)",
  },
  {
    id: 'C-7.14',
    desc: '提醒态清空时钟，换成文案',
    file: 'pages/clock/index.js',
    from: "      mainText: formatHM(new Date()), // 中间不换字，提醒只由边缘的光表达（C-7.14）\n      targetText: '',",
    to: "      mainText: '',\n      targetText: '',",
  },
  {
    id: 'C-7.14',
    desc: '提醒态不走时，数字冻在到点那一分',
    file: 'pages/clock/index.js',
    from: "    else if (state === 'idle' || state === 'alert') this.renderClock(false)",
    to: "    else if (state === 'idle') this.renderClock(false)",
  },
  {
    id: 'C-7.16',
    desc: '删掉静态 opacity 兜底，动画一停就全黑',
    file: 'styles/glow.wxss',
    from: '.glow-on {\n  opacity: 1;\n  animation: breathe 5s ease-in-out infinite;\n}',
    to: '.glow-on {\n  animation: breathe 5s ease-in-out infinite;\n}',
  },
  {
    id: 'C-3.4',
    desc: '拆掉 renderClock 状态守卫，到点后秒赖着不走',
    file: 'pages/clock/index.js',
    from: "    const withSec = this.data.state === 'running' && !!finalPhase",
    to: '    const withSec = !!finalPhase',
  },
  {
    id: 'C-7.15',
    desc: '发光色退回硬编码，配色改不动',
    file: 'utils/prefs.js',
    from: "'inset 0 0 ' + NEAR_R[i] + 'vh 0 ' + rgba(rgb, v)",
    to: "'inset 0 0 ' + NEAR_R[i] + 'vh 0 rgba(94, 214, 160, ' + v + ')'",
  },
  {
    id: 'C-7.15',
    desc: '非法强度回落到列表第一项（淡）',
    file: 'utils/prefs.js',
    from: '    level: find(LEVELS, levelId) ? levelId : DEFAULT_LEVEL,',
    to: '    level: find(LEVELS, levelId) ? levelId : LEVELS[0].id,',
  },
  {
    id: 'C-7.15',
    desc: 'glowStyles 把颜色写死成绿色',
    file: 'utils/prefs.js',
    from: '  const rgb = find(COLORS, p.color).rgb',
    to: "  const rgb = '94, 214, 160'",
  },
  {
    id: 'C-11.1',
    desc: '业务代码留 console.log',
    file: 'app.js',
    from: '    // 页面全部在前台常亮运行，无全局状态',
    to: "    console.log('boot')",
  },
]

const rows = []

for (const c of CASES) {
  const { base, dst } = copyProject()
  try {
    const file = path.join(dst, c.file)
    const src = fs.readFileSync(file, 'utf8')

    if (!src.includes(c.from)) {
      rows.push({ ...c, got: '锚点缺失' })
      continue
    }

    fs.writeFileSync(file, src.replace(c.from, c.to))
    const verdict = parseVerdicts(runCheck(dst))[c.id]
    rows.push({ ...c, got: verdict === 'FAIL' ? '抓到' : `漏过（${verdict || '无此项'}）` })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

console.log('\n宪法变异测试 · 故意改坏代码，看条款能不能抓到\n')
for (const r of rows) {
  const mark = r.got === '抓到' ? 'OK  ' : 'MISS'
  console.log(`  ${mark} ${r.id.padEnd(8)} ${r.desc.padEnd(24)} ${r.got}`)
}

const caught = rows.filter((r) => r.got === '抓到').length
console.log(`\n抓到 ${caught} / ${rows.length}\n`)
process.exitCode = caught === rows.length ? 0 : 1
