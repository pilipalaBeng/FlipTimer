/** 时间格式化工具 */

const pad2 = (n) => (n < 10 ? '0' + n : String(n))

/** 当前时刻 HH:mm（24 小时制） */
function formatHM(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 当前时刻 HH:mm:ss，仅最后一分钟使用 */
function formatHMS(date) {
  return formatHM(date) + ':' + pad2(date.getSeconds())
}

/** 右下角角标：本轮什么时候提醒 */
function formatTarget(ts) {
  return '提醒时间 ' + formatHM(new Date(ts))
}

module.exports = { pad2, formatHM, formatHMS, formatTarget }
