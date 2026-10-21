/**
 * 倒计时内核
 *
 * 只存目标时间戳，剩余时间永远由 targetTs - Date.now() 现算。
 * 好处：切后台、定时器漂移、掉帧都不影响准确性。
 */

class Countdown {
  constructor() {
    this.targetTs = 0
  }

  start(durationMs) {
    this.targetTs = Date.now() + durationMs
  }

  /** 冷启动恢复：直接接管上次的目标时间戳，剩余时间照常现算 */
  resume(targetTs) {
    const n = Number(targetTs)
    this.targetTs = Number.isFinite(n) && n > 0 ? n : 0
  }

  reset() {
    this.targetTs = 0
  }

  get active() {
    return this.targetTs > 0
  }

  get remaining() {
    if (!this.targetTs) return 0
    return Math.max(0, this.targetTs - Date.now())
  }

  get finished() {
    return this.targetTs > 0 && Date.now() >= this.targetTs
  }
}

module.exports = Countdown
