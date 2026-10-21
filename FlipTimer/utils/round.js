/**
 * 本轮目标时间戳的落盘与回收（冷启动恢复用）。
 *
 * 单独成模块的理由和 prefs 一样：storage 键名不该散在页面里，
 * 值域校验也不该在每个调用点各写一份。
 *
 * 只存这一个数。剩余时间永远能由「目标时间戳 − 现在」现算（C-3.1），
 * 存剩余秒数、存状态名都属于把能重算的东西写进磁盘（C-5.2）。
 */

const KEY = 'flip_timer_round_target'

/** @param {number} targetTs 0 表示没有进行中的一轮，不写盘 */
function save(targetTs) {
  if (targetTs > 0) wx.setStorageSync(KEY, targetTs)
}

function clear() {
  wx.removeStorageSync(KEY)
}

/** @returns {number} 没有/已损坏一律 0，页面据此当作"没有上一轮" */
function read() {
  const n = Number(wx.getStorageSync(KEY))
  return Number.isFinite(n) && n > 0 ? n : 0
}

module.exports = { save, clear, read }
