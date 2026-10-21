/**
 * 漏洞验证脚本：模拟真实翻转动作
 *
 * 注意：这里的 wx 替身**故意没有 startGyroscope**，所以它走的是
 * `_startAccel()` 降级路径 —— 这个脚本验的就是"陀螺仪起不来时，
 * 加速度计那套点积判据能不能兜住"。主路径（平放桌面内旋转）在
 * test/simulate.js 里，用角速度驱动。
 *
 * 手机立在桌上要翻 180°，必须先拿起来，空中转半圈再放回去。
 * 这个动作不会只沿单轴变化，一定会经过其他主轴。
 *
 * 跑法：node test/gap-check.js
 */

let vnow = 1700000000000
Date.now = () => vnow

let accelHandler = null
global.wx = {
  requirePrivacyAuthorize: ({ success }) => success(),
  startAccelerometer: ({ success }) => success(),
  onAccelerometerChange: (fn) => {
    accelHandler = fn
  },
  offAccelerometerChange: () => {},
  stopAccelerometer: () => {},
}

const FlipDetector = require('../utils/flip')

let fires = 0
let poses = []
const fd = new FlipDetector({ onPose: (down) => poses.push(down) })
fd.start()

/** 动作走队列，这里把已确认的翻转取走并累计（原先靠 onFlip 回调计数） */
function drain() {
  fires += fd.takeTurns()
}

function feed(s) {
  vnow += 20
  if (accelHandler) accelHandler(s)
}

function hold(s, ms) {
  const n = Math.max(1, Math.round(ms / 20))
  for (let i = 0; i < n; i++) feed(s)
}

function swing(a, b, ms) {
  const n = Math.max(1, Math.round(ms / 20))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    feed({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
  }
}

const UP = { x: -1, y: 0, z: 0 } // 横屏立着，正立
const DOWN = { x: 1, y: 0, z: 0 } // 横屏立着，翻转 180°
const TILT = { x: 0, y: 1, z: 0 } // 拿在手里竖起来（翻转途中的中间姿态）

// 场景 A：理想轨迹 —— 只沿 x 轴从 -1 直线变到 +1（物理上不存在）
hold(UP, 1500)
swing(UP, DOWN, 800)
hold(DOWN, 1500)
drain()
const firesA = fires

// 复位
fires = 0
fd.reset()
hold(UP, 1500)

// 场景 B：真实轨迹 —— 拿起来先竖直，转半圈，再倒着放回
swing(UP, TILT, 600)
swing(TILT, DOWN, 600)
hold(DOWN, 1500)
drain()
const firesB = fires

console.log('\n翻转识别 · 轨迹对比\n')
console.log(`  场景 A 理想直线轨迹  触发 ${firesA} 次  ${firesA === 1 ? 'OK' : '异常'}`)
console.log(`  场景 B 真实拿起翻转  触发 ${firesB} 次  ${firesB === 1 ? 'OK' : '漏检！'}`)
console.log(`\n  最终姿态上报: ${JSON.stringify(poses)}\n`)
process.exitCode = firesB === 1 ? 0 : 1
