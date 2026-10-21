/**
 * 悬浮钮的展开 / 收起状态机。
 *
 * 独立成模块有两个原因：
 * 1. 页面里已经挤了状态机、计时、持久化，再塞一套"几秒后自己缩回去"的
 *    定时器逻辑会混成一团；
 * 2. 它不碰 wx，纯定时器 + 回调，可以脱离小程序直接测。
 */

const FAB_HOLD_MS = 3000 // 展开后多久没操作就缩回

/**
 * @param {(open:boolean)=>void} onChange 展开态变化时回调，页面据此 setData
 */
class FabSwitch {
  constructor(onChange) {
    this.onChange = onChange
    this.open = false
    this.timer = null
  }

  /** 细棍点一下：开着就收起，收起就展开并开始倒计时 */
  toggle() {
    if (this.open) return this.close()
    this.open = true
    this.onChange(true)
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = null
      this.open = false
      this.onChange(false)
    }, FAB_HOLD_MS)
  }

  close() {
    this.clear()
    if (!this.open) return
    this.open = false
    this.onChange(false)
  }

  /** 页面隐藏时把定时器掐掉，回来不莫名其妙自己缩 */
  clear() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

module.exports = { FabSwitch, FAB_HOLD_MS }
