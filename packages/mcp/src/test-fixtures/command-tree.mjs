// shell 值解析的进程树回收 fixture，仅写测试临时目录。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
})
writeFileSync(join(process.cwd(), 'command-pids.json'), JSON.stringify([process.pid, child.pid]))
setInterval(() => {}, 1000)
