/**
 * 悬浮钮定位：把微信胶囊的矩形换算成内联样式。
 *
 * 右上角那颗胶囊（··· / ×）是原生层，横屏下也压在右上角，
 * 页面既盖不住也挤不开它，只能贴着它往下站。
 * 手写 vh/vw 在异形屏、分屏、不同机型上会漂，所以位置一律由胶囊矩形算。
 *
 * ── 为什么不再做镜像（1.19 加过，1.20 撤掉）──
 * 1.19 假设"系统不转页面"，于是翻转后把锚点镜像到物理左下角，想让它在人眼里
 * 回到右上角。**这个前提是错的**：页面固定横屏（pageOrientation: landscape），
 * 手机立在桌面上翻 180° 时重力向量整体反号，系统会自己把页面转过来。
 * 既然页面坐标系已经跟着转了，钮贴在页面右上角，人眼里就还是右上角 ——
 * 镜像反而把它送到对角去。详见 C-7.11。
 */

const FALLBACK_TOP = 13 // vh，拿不到胶囊时用
const FALLBACK_RIGHT = 3 // vw
const GAP_PX = 6 // 与胶囊下沿的缝

/**
 * 读胶囊矩形与窗口尺寸。拿不到就返回空，交给 fabStyle 回落。
 * 单独成函数是为了让页面那侧只剩一行：try/catch 和判空不该占页面行数。
 * @returns {{rect:object|null,win:object|null}}
 */
function menuRect() {
  try {
    const rect = wx.getMenuButtonBoundingClientRect()
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return { rect, win }
  } catch (e) {
    return { rect: null, win: null }
  }
}

/**
 * @param {{rect:object|null,win:object|null}} pos menuRect() 的结果
 * @returns {string} 形如 "top: 44px; right: 6px;"
 */
function fabStyle(pos) {
  const p = pos || {}
  if (!usable(p.rect, p.win)) return fallback()
  const top = Math.round(p.rect.bottom + GAP_PX)
  const right = Math.round(p.win.windowWidth - p.rect.right)
  return `top: ${top}px; right: ${right}px;`
}

function fallback() {
  return `top: ${FALLBACK_TOP}vh; right: ${FALLBACK_RIGHT}vw;`
}

/**
 * 两种情况都宁可回落到固定值：
 * 横屏下拿到竖屏坐标（算出的 right 会跑到屏幕外），
 * 以及系统把页面转过去之后胶囊落到下半屏（它已不在页面的右上角了）。
 */
function usable(rect, win) {
  if (!rect || !win) return false
  if (!(rect.width > 0 && rect.bottom > 0)) return false
  const right = win.windowWidth - rect.right
  return rect.bottom < win.windowHeight * 0.35 && right >= 0 && right < win.windowWidth * 0.3
}

module.exports = { fabStyle, menuRect, FALLBACK_TOP, FALLBACK_RIGHT }
