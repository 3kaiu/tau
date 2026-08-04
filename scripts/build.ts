// 单二进制分发:交叉编译各平台 tau。
// 无运行时依赖(Bun 运行时嵌进产物),用户 curl 一个文件就能跑。

const TARGETS = [
  { target: "bun-darwin-arm64", out: "tau-darwin-arm64" },
  { target: "bun-darwin-x64", out: "tau-darwin-x64" },
  { target: "bun-linux-x64", out: "tau-linux-x64" },
  { target: "bun-linux-arm64", out: "tau-linux-arm64" },
  { target: "bun-windows-x64", out: "tau-windows-x64.exe" },
] as const

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const selected = only.length > 0 ? TARGETS.filter((t) => only.some((o) => t.target.includes(o))) : TARGETS
if (selected.length === 0) {
  console.error(`build:无匹配目标。可选:${TARGETS.map((t) => t.target).join(", ")}`)
  process.exit(2)
}

let failed = 0
for (const { target, out } of selected) {
  const outfile = `dist/${out}`
  const proc = Bun.spawnSync([
    "bun",
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    `--target=${target}`,
    "packages/app/src/main.ts",
    "--outfile",
    outfile,
  ])
  if (proc.exitCode !== 0) {
    console.error(`✗ ${target}\n${proc.stderr.toString()}`)
    failed += 1
    continue
  }
  const size = Bun.file(outfile).size
  console.log(`✓ ${target.padEnd(20)} ${outfile}  ${(size / 1024 / 1024).toFixed(1)} MB`)
}

if (failed > 0) {
  console.error(`build:${failed}/${selected.length} 个目标失败`)
  process.exit(1)
}
console.log(`build:${selected.length} 个目标就绪(dist/)`)
