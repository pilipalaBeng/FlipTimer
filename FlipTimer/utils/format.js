/** 时间格式化工具 */

const pad2 = (n) => (n < 10 ? '0' + n : String(n))

/** 当前时刻 HH:mm（24 小时制） */
function formatHM(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 时分秒。中间区只在最后一分钟用它；右下角的提醒时刻一直用 */
function formatHMS(date) {
  return formatHM(date) + ':' + pad2(date.getSeconds())
}

/**
 * 右下角角标：本轮什么时候提醒。
 * 必须带秒：目标时刻是「开始那一刻 + N 分钟」，秒数继承自开始时刻（10:23:41 起 25 分钟
 * → 10:48:41）。只写到分，用户看着 10:48 等到 10:48:00 没动静，会以为坏了。
 */
function formatTarget(ts) {
  return '提醒时间 ' + formatHMS(new Date(ts))
}

module.exports = { pad2, formatHM, formatHMS, formatTarget }
