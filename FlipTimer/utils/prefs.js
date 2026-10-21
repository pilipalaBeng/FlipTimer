/**
 * 用户偏好的读写：提醒间隔、提醒光配色。
 *
 * 单独成模块的理由：这两件事是同一个模式 —— 用户选择、立刻落盘、非法值回落。
 * 散在页面里就是两份几乎相同的代码，而且 storage 键名会出现在每个调用点。
 */

const KEY_DURATION = 'flip_timer_duration_min'
const KEY_GLOW = 'flip_timer_glow'

const DEFAULT_MIN = 30
const MIN_MIN = 1
const MAX_MIN = 180

const DEFAULT_COLOR = 'green'
const DEFAULT_LEVEL = 'std'

/**
 * 三色够用。取值都压过饱和度 —— 纯 #FF0000 在全黑屏上像报警灯，
 * 边缘光要的是"余光扫到能注意到"，不是"扎眼"。
 */
const COLORS = [
  { id: 'green', name: '绿', rgb: '94, 214, 160' },
  { id: 'red', name: '红', rgb: '228, 92, 84' },
  { id: 'blue', name: '蓝', rgb: '96, 158, 226' },
]

/**
 * 强度 = 基础 alpha 的倍率，不是用户直接填 alpha。
 * 直接暴露 alpha 数值对用户没有意义（0.38 是什么概念？），
 * 而且能把光调到全亮，中间的时间就看不见了。
 * 近场最亮层 0.38 是调出来的，浓档 1.3 倍到 0.494 仍在安全区。
 */
const LEVELS = [
  { id: 'soft', name: '淡', k: 0.72 },
  { id: 'std', name: '标准', k: 1 },
  { id: 'strong', name: '浓', k: 1.3 },
]

const BASE = { near: [0.38, 0.26, 0.17], far: 0.14 }
const NEAR_R = [2, 6, 12] // 近场三层模糊半径（vh）

function find(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i]
  }
  return null
}

function round3(v) {
  return Math.round(v * 1000) / 1000
}

/**
 * 非法值回落到显式默认，不是"列表第一项"。
 * 这两个列表的第一项恰好不是默认档（强度第一项是「淡」），
 * 用 list[0] 兜底会让"存储被写坏"和"首次进入"落到不同档位。
 */
function normalizeGlow(colorId, levelId) {
  return {
    color: find(COLORS, colorId) ? colorId : DEFAULT_COLOR,
    level: find(LEVELS, levelId) ? levelId : DEFAULT_LEVEL,
  }
}

function readGlow() {
  const parts = String(wx.getStorageSync(KEY_GLOW) || '').split('|')
  return normalizeGlow(parts[0], parts[1])
}

function writeGlow(colorId, levelId) {
  const p = normalizeGlow(colorId, levelId)
  wx.setStorageSync(KEY_GLOW, p.color + '|' + p.level)
  return p
}

function rgba(rgb, a) {
  return 'rgba(' + rgb + ', ' + a + ')'
}

/**
 * 整条发光样式直接拼成字符串，绑到 style 上。
 *
 * 为什么不用 CSS 变量：WXSS 编译器会逐个校验 rgba() 的参数，
 * 撞上 var(--gc) 这种非数值就**把整条声明丢掉**——不报错、控制台也看不出来，
 * 真机上只表现为「到点了，屏幕一点光都没有」。样式走 style 属性是运行时字符串，
 * 由 WebView 直接解析，绕开编译期的这道校验。
 *
 * 三色 × 三档仍然只算一次，不用写九份。
 */
function glowStyles(colorId, levelId) {
  const p = normalizeGlow(colorId, levelId)
  const rgb = find(COLORS, p.color).rgb
  const k = find(LEVELS, p.level).k
  const a = BASE.near.map((v) => round3(v * k))
  const fa = round3(BASE.far * k)
  const zero = rgba(rgb, 0)

  const near =
    'box-shadow: ' +
    a.map((v, i) => 'inset 0 0 ' + NEAR_R[i] + 'vh 0 ' + rgba(rgb, v)).join(', ')

  const far =
    'background-image: ' +
    [
      'linear-gradient(to bottom, ' + rgba(rgb, fa) + ', ' + zero + ')',
      'linear-gradient(to top, ' + rgba(rgb, fa) + ', ' + zero + ')',
      'linear-gradient(to right, ' + rgba(rgb, fa) + ', ' + zero + ')',
      'linear-gradient(to left, ' + rgba(rgb, fa) + ', ' + zero + ')',
    ].join(', ') +
    '; background-size: 100% 24%, 100% 24%, 24% 100%, 24% 100%' +
    '; background-position: top left, bottom left, top left, top right'

  const pre =
    'box-shadow: inset 0 0 2.5vh 0 ' +
    rgba(rgb, a[0]) +
    ', inset 0 0 6vh 0 ' +
    rgba(rgb, fa)

  return { near: near, far: far, pre: pre }
}

function readDuration() {
  const n = Math.round(Number(wx.getStorageSync(KEY_DURATION)))
  if (!n || n < MIN_MIN || n > MAX_MIN) return DEFAULT_MIN
  return n
}

/** 越界值不写入，直接回默认档，避免存进去一个永远用不上的数 */
function writeDuration(min) {
  const n = Math.round(Number(min))
  const v = n >= MIN_MIN && n <= MAX_MIN ? n : DEFAULT_MIN
  wx.setStorageSync(KEY_DURATION, v)
  return v
}

module.exports = {
  COLORS,
  LEVELS,
  DEFAULT_MIN,
  DEFAULT_COLOR,
  DEFAULT_LEVEL,
  MIN_MIN,
  MAX_MIN,
  normalizeGlow,
  readGlow,
  writeGlow,
  glowStyles,
  readDuration,
  writeDuration,
}
